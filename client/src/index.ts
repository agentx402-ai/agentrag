import {
  assertFiniteUsd as coreAssertFiniteUsd,
  fetchWithRetry as coreFetchWithRetry,
  SpendLedger,
} from "@agentx402-ai/core";
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { isAccountKeyFormat } from "./account";
import { AgentRagError, ragErrorFromResponse, SpendCapError } from "./errors";
import {
  buildBearerHeaders,
  buildIdentityHeaders,
  buildPaymentHeader,
  challengePriceUsd,
  creditsRemaining,
  freshNonce,
  nonceFromIdempotencyKey,
  settledTxHash,
} from "./payment";
import { askAuthorizedCeilingUsd } from "./pricing";
import type {
  AgentRagOptions,
  AskOptions,
  AskPending,
  AskResult,
  RagModelId,
  Signer,
} from "./types";

export { generateAccountKey, isAccountKeyFormat } from "./account";
export {
  AgentRagError,
  AgentXError,
  type RagErrorCode,
  ragErrorFromResponse,
  SpendCapError,
} from "./errors";
export * from "./types";
export * from "./usage";

// Compiled into the published bundle and reported to the service; kept in lockstep with
// package.json's version by the `versions` CI job (version-lockstep source 3 of 6).
export const VERSION = "0.1.0";

/** Fixed at collection creation — an `ingest` against an existing collection with a
 * different model is rejected server-side (model_mismatch). */
export const DEFAULT_MODEL: RagModelId = "@cf/baai/bge-m3";

// Pinned prices (USD) — parity-guarded against the worker's own price registry by a
// cross-repo CI check. The wire price always comes from the server's 402 challenge;
// these are used only for client-side pre-request authorized-ceiling math (pricing.ts).
export const ASK_BASE_USD = 0.008;
export const INGEST_PAGE_USD = 0.005;
export const EXTEND_BLOCK_USD = 0.01;
export const CHUNKS_PER_BLOCK = 5_000;

// Backstop + float slack, both copied from agentscout/client/src/index.ts:
/** Ceiling for any op declaring no authorizedCeilingUsd, when no maxSpendUsd is set. */
export const DEFAULT_MAX_OP_USD = 0.05;
/** Absorbs float error so an honest quote exactly on a boundary is not falsely rejected. */
export const PRICE_EPS = 0.000001;

// Client-side limits mirroring the worker's validation — enforced before any request is sent.
export const MAX_QUERY_CHARS = 1_000;
export const MAX_TOP_K = 20;
export const MAX_PAGES_PER_CALL = 200;
export const MAX_DOCUMENTS = 100;
// 100 KiB, matching the worker's MAX_DOCUMENT_TEXT_BYTES exactly — NOT 100_000.
// Measured the same way the worker measures it: TextEncoder().encode(text).length.
// A stricter client value fails safe but spuriously rejects documents the service
// would have accepted, so the two must agree to the byte.
export const MAX_DOCUMENT_BYTES = 100 * 1024;

// askAndWait defaults. `DEFAULT_ASK_POLL_INTERVAL_MS` is a fallback only — ordinarily the
// wait between polls is governed by the 202's own `retry_after` (see askAndWait's doc
// comment), not this constant.
/** Overall polling budget before `askAndWait` throws `ingest_timeout`, absent an explicit `maxWaitMs`. */
export const DEFAULT_ASK_WAIT_MS = 120_000;
/** Fallback delay between polls, used only when both `pollIntervalMs` and the 202's `retry_after` are absent/non-positive. */
export const DEFAULT_ASK_POLL_INTERVAL_MS = 15_000;

const DEFAULT_NETWORK = "eip155:8453";
// Mirrors the worker's own `mode` enum (routes/ask.ts's parseAskBody).
const ASK_MODES = ["hybrid", "dense", "bm25"] as const;
// Mirrors the worker's own `max_pages` default (routes/ask.ts's parseAskBody) — used ONLY
// to size the authorized-ceiling formula when the caller omits `maxPages`; the wire
// request itself omits `max_pages` too in that case, so the worker applies this same default.
const DEFAULT_ASK_MAX_PAGES = 20;

/**
 * Fail closed on a malformed money bound. A spend cap that is not a finite, non-negative
 * number is REJECTED here — never stored and silently ignored. Money-safety invariant: a
 * malformed cap fails closed, never "unlimited". The dangerous value is a non-finite one
 * — `usd > NaN` is always false, so an unchecked NaN would void every downstream price
 * guard, including the DEFAULT_MAX_OP_USD backstop (which only runs when maxSpendUsd is
 * unset — a stored NaN would look "configured" while bounding nothing).
 */
function assertFiniteUsd(value: unknown, label: string): void {
  try {
    coreAssertFiniteUsd(value, label);
  } catch (e) {
    // Core owns the RULE; this SDK owns its error IDENTITY. `AgentRagError` is exported
    // and callers catch it, so letting core's base `AgentXError` escape here would leave
    // this the one throw site a `catch (e) { if (e instanceof AgentRagError) }` silently
    // misses. `e.code` is unchanged either way.
    throw new AgentRagError((e as Error).message, "invalid_config", 0);
  }
}

/**
 * Mirrors the worker's own source-grammar validation (ingest/sources.ts's `resolveOne`) so
 * a malformed source is rejected client-side before any request: an exact http(s) URL, or
 * a URL whose path ends with the literal trailing segment "/**" (a same-origin crawl
 * root). "**" is grammar ONLY as a whole trailing segment — anywhere else is rejected with
 * a precise reason instead of a generic parse failure.
 */
function assertValidSource(entry: string): void {
  const isCrawl = entry.endsWith("/**");
  if (!isCrawl && entry.includes("**")) {
    throw new AgentRagError(
      `invalid source ${JSON.stringify(entry)}: "**" is only valid as a trailing path segment ("/**")`,
      "invalid_request",
      0,
    );
  }
  const candidate = isCrawl ? entry.slice(0, -2) : entry; // strip trailing "**", keep the "/"
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new AgentRagError(
      `invalid source ${JSON.stringify(entry)}: not a valid URL`,
      "invalid_request",
      0,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new AgentRagError(
      `invalid source ${JSON.stringify(entry)}: unsupported URL scheme "${parsed.protocol}"`,
      "invalid_request",
      0,
    );
  }
}

/** Type guard distinguishing a 202 (`AskPending`) from a settled `AskResult`. */
function isAskPending(result: AskResult | AskPending): result is AskPending {
  return (result as AskPending).status === "ingesting";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class AgentRag {
  readonly endpoint: string;
  readonly network: string;
  readonly signer?: Signer;
  readonly accountKey?: string;
  readonly maxSpendUsd?: number;
  readonly maxSessionSpendUsd?: number;
  readonly expectedPayTo?: `0x${string}`;
  readonly maxRetries: number;
  protected readonly timeoutMs?: number;
  protected readonly fetchImpl?: typeof fetch;
  /**
   * The spend bounds, including the in-flight reservation that makes the cumulative cap
   * hold under concurrency (see `@agentx402-ai/core`'s SpendLedger doc comment for the
   * three-concurrent-ops incident this closes).
   */
  protected readonly ledger: SpendLedger;

  constructor(opts: AgentRagOptions) {
    // Fail fast (invalid_config) at construction. The endpoint decides WHICH host issues
    // the 402 a wallet then signs against, so a malformed one must not survive to a
    // paying op: a non-string (a config.json value survives JSON.parse as any type) dies
    // with a bare TypeError on `.replace`, and a relative or non-http(s) string
    // ("rag.example", "ftp://h") only surfaces as an opaque "Invalid URL" from the first
    // — possibly paying — request. Same construction-time pin as expectedPayTo below.
    if (typeof opts?.endpoint !== "string" || opts.endpoint === "") {
      throw new AgentRagError(
        "endpoint is required (an absolute http(s) URL)",
        "invalid_config",
        0,
      );
    }
    try {
      const u = new URL(opts.endpoint);
      if (u.protocol !== "http:" && u.protocol !== "https:") {
        throw new Error("unsupported protocol");
      }
    } catch {
      throw new AgentRagError(
        `endpoint must be an absolute http(s) URL (got ${JSON.stringify(opts.endpoint)})`,
        "invalid_config",
        0,
      );
    }
    this.endpoint = opts.endpoint.replace(/\/+$/, "");
    this.network = opts.network ?? DEFAULT_NETWORK;
    this.maxSpendUsd = opts.maxSpendUsd;
    this.maxSessionSpendUsd = opts.maxSessionSpendUsd;
    // Fail closed on a malformed cap: a non-finite/negative value must throw at
    // construction, never be stored (a NaN cap makes every `usd > cap` check false ->
    // unlimited spend, and also silently disables the DEFAULT_MAX_OP_USD backstop, which
    // only runs when maxSpendUsd is unset).
    assertFiniteUsd(this.maxSpendUsd, "maxSpendUsd");
    assertFiniteUsd(this.maxSessionSpendUsd, "maxSessionSpendUsd");
    // Validated above with this SDK's own error class, so the ledger's identical
    // re-check never fires — it would throw core's base type, which callers do not catch.
    this.ledger = new SpendLedger({
      maxSpendUsd: this.maxSpendUsd,
      maxSessionSpendUsd: this.maxSessionSpendUsd,
    });
    this.maxRetries = Math.max(0, Math.floor(opts.maxRetries ?? 2));
    this.timeoutMs = opts.timeoutMs;
    this.fetchImpl = opts.fetchImpl;

    if (opts.expectedPayTo !== undefined) {
      try {
        this.expectedPayTo = getAddress(opts.expectedPayTo);
      } catch {
        throw new AgentRagError("expectedPayTo must be a valid 0x address", "invalid_config", 0);
      }
    }

    // AgentRagOptions is a FLAT interface (unlike AgentScout's discriminated union), so
    // "exactly one auth shape" is a runtime contract only — TypeScript accepts any
    // combination of these three optional fields. Discriminate on the VALUE, not mere
    // key presence: a spread config's `{ ...cfg, privateKey: undefined }` must fall
    // through past a truthiness-only check.
    const hasPrivateKey = opts.privateKey !== undefined && opts.privateKey !== null;
    const hasSigner = opts.signer !== undefined && opts.signer !== null;
    const hasAccountKey = opts.accountKey !== undefined && opts.accountKey !== null;

    if (hasAccountKey && (hasPrivateKey || hasSigner)) {
      throw new AgentRagError(
        "provide exactly one auth shape: wallet ({ privateKey } or { signer }) OR " +
          "{ accountKey }, not both",
        "invalid_config",
        0,
      );
    }
    if (hasPrivateKey && hasSigner) {
      throw new AgentRagError(
        "provide at most one of { privateKey } or { signer }, not both",
        "invalid_config",
        0,
      );
    }
    if (hasSigner) {
      this.signer = opts.signer;
    } else if (hasPrivateKey) {
      try {
        this.signer = privateKeyToAccount(opts.privateKey!);
      } catch (e) {
        throw new AgentRagError(
          `privateKey must be a valid 0x-prefixed EVM private key: ${(e as Error).message}`,
          "invalid_config",
          0,
        );
      }
    } else if (hasAccountKey) {
      if (!isAccountKeyFormat(opts.accountKey)) {
        throw new AgentRagError(
          "accountKey must be of the form ak_<64 lowercase hex>",
          "invalid_config",
          0,
        );
      }
      this.accountKey = opts.accountKey;
    } else {
      throw new AgentRagError(
        "invalid auth config: provide one of { privateKey } | { signer } | { accountKey }",
        "invalid_config",
        0,
      );
    }
  }

  protected fetchWithRetry(
    url: string,
    build: () => RequestInit | Promise<RequestInit>,
  ): Promise<Response> {
    return coreFetchWithRetry(url, build, this.maxRetries, {
      timeoutMs: this.timeoutMs,
      fetchImpl: this.fetchImpl,
    });
  }

  protected async asError(res: Response, fallback: string): Promise<AgentRagError> {
    return ragErrorFromResponse(res, fallback);
  }

  // These stay as named `protected` methods rather than inlined `this.ledger.*` calls:
  // a subclass (including the white-box money tests) can drive them directly, and the
  // arithmetic itself lives in core.

  /** Throw `SpendCapError` if `usd` breaches the per-call or cumulative bound. */
  protected assertSpend(usd: number): void {
    this.ledger.assertSpend(usd);
  }

  /** Move a settled amount into cumulative spend. */
  protected recordSpend(usd: number): void {
    this.ledger.record(usd);
  }

  /**
   * Reserve `usd` against the session cap SYNCHRONOUSLY. Returns a release fn the caller
   * MUST invoke exactly once (in a `finally`) — releasing is idempotent so a double call
   * cannot leak budget back.
   */
  protected reserveSession(usd: number): () => void {
    return this.ledger.reserve(usd);
  }

  /**
   * `assertSpend` + a synchronous reservation, for a path that is about to SIGN. The
   * caller MUST release in a `finally`. Nothing may `await` between the check and the
   * reservation, or a concurrent op can pass the same stale check before this one lands.
   */
  protected assertAndReserveSpend(usd: number): () => void {
    return this.ledger.assertAndReserve(usd);
  }

  /**
   * Built-in op-price ceiling. When no explicit maxSpendUsd is set, refuse a
   * server-quoted 402 price above DEFAULT_MAX_OP_USD so a spoofed/compromised challenge
   * cannot drain the wallet in the default (no-cap) config. A per-op backstop beneath the
   * tighter authorized-ceiling check, and the ONLY guard for an op that declares no
   * authorizedCeilingUsd of its own.
   */
  protected assertOpPriceCeiling(usd: number): void {
    // Negated <= (not >): a non-finite operand then fails CLOSED instead of open
    // (hardening; a quoted price is already digits-only-validated by core, so this
    // cannot fire today).
    if (this.maxSpendUsd === undefined && !(usd <= DEFAULT_MAX_OP_USD)) {
      throw new SpendCapError(
        `server-quoted op price $${usd} exceeds the built-in $${DEFAULT_MAX_OP_USD} op ceiling; ` +
          "set maxSpendUsd to allow a higher per-op charge",
      );
    }
  }

  /**
   * Shared caller-side x402 orchestrator, adapted from AgentScout's — AgentRAG v1 pays no
   * publisher tolls, so every toll concept from that template is dropped. Account-key
   * mode issues exactly ONE bearer-authenticated request — no probe, no 402, no signing.
   * Wallet mode: bare probe -> on 402, price the challenge and run every guard BEFORE
   * signing (the caller's authorized ceiling, or the DEFAULT_MAX_OP_USD backstop when an
   * op declares none; then a SYNCHRONOUS spend-cap reservation) -> sign the challenge
   * VERBATIM (buildPaymentHeader pins expectedNetwork + canonical USDC + expectedPayTo,
   * and refuses a payTo mismatch BEFORE signing) -> retry the SAME url with the SAME
   * Idempotency-Key plus PAYMENT-SIGNATURE.
   */
  protected async performOp<T>(spec: {
    method: "GET" | "POST";
    path: string; // signed pathname (no query) — reserved for a future identity-signed op
    url: string; // full request URL
    idempotencyKey: string;
    label: string;
    // Caller-authorized USD ceiling for this op (from pricing.ts, computed off the
    // REQUEST SHAPE per spec §11.3). A 402 quoting more than this (beyond float slack) is
    // refused BEFORE signing, so a lying/spoofed/MITM'd server cannot inflate the amount.
    // Undefined means the op declares no ceiling of its own, falling back to the
    // DEFAULT_MAX_OP_USD backstop (assertOpPriceCeiling) below.
    authorizedCeilingUsd?: number;
    buildRequest: (headers: Record<string, string>) => RequestInit;
    parseSuccess: (res: Response) => Promise<T>;
  }): Promise<T> {
    const { url, idempotencyKey, label } = spec;

    // ---- Account-key (bearer) mode ----
    if (this.accountKey) {
      const res = await this.fetchWithRetry(url, () =>
        spec.buildRequest({
          "Idempotency-Key": idempotencyKey,
          ...buildBearerHeaders(this.accountKey!),
        }),
      );
      if (!res.ok) throw await this.asError(res, label); // 402 insufficient_credits surfaces here
      return spec.parseSuccess(res);
    }

    // ---- Wallet (x402) mode ----
    // 1) Bare discovery probe.
    let res = await this.fetchWithRetry(url, () =>
      spec.buildRequest({ "Idempotency-Key": idempotencyKey }),
    );

    // 2) 402 -> pay the exact quoted amount and retry once (same key => exactly-once).
    if (res.status === 402) {
      const challenge = res.headers.get("PAYMENT-REQUIRED");
      if (!challenge) {
        throw await this.asError(res, "payment required but no PAYMENT-REQUIRED challenge");
      }
      const usd = challengePriceUsd(challenge, undefined, this.network);
      // Money-safety: every guard below runs BEFORE any signature is produced.
      if (spec.authorizedCeilingUsd !== undefined) {
        // Defense in depth at the signing choke point: a non-finite ceiling (a NaN that
        // somehow reached here) is a HARD refusal, not a vacuous `usd > NaN` that always
        // passes. Inputs are validated upstream (pricing.ts arithmetic on finite
        // constants), so this only fires on a bug — but this is the last gate before a
        // signature, so it refuses rather than trusts.
        if (!Number.isFinite(spec.authorizedCeilingUsd)) {
          throw new SpendCapError(
            `authorized ceiling $${spec.authorizedCeilingUsd} is not a finite amount; refusing to sign`,
          );
        }
        // Negated <= so a non-finite `usd` (unreachable today — core validates a quoted
        // amount as digits-only) would refuse rather than vacuously pass.
        if (!(usd <= spec.authorizedCeilingUsd + PRICE_EPS)) {
          throw new SpendCapError(
            `server quoted $${usd} but the client only authorized $${spec.authorizedCeilingUsd}; ` +
              "refusing to sign",
          );
        }
      } else {
        this.assertOpPriceCeiling(usd);
      }
      // Explicit per-op + cumulative session caps, plus a SYNCHRONOUS reservation of
      // this op's amount. The reservation is what makes the session cap hold under
      // concurrency: `recordSpend` runs only after the paid round-trip below, so without
      // it N parallel ops would all check the same stale counter, all pass, and all
      // sign. Nothing may await between the check and the reservation.
      const release = this.assertAndReserveSpend(usd);
      try {
        const paymentSignature = await buildPaymentHeader(this.requireSigner(), challenge, {
          expectedNetwork: this.network,
          expectedPayTo: this.expectedPayTo,
          nonce: nonceFromIdempotencyKey(idempotencyKey),
        });
        res = await this.fetchWithRetry(url, () =>
          spec.buildRequest({
            "Idempotency-Key": idempotencyKey,
            "PAYMENT-SIGNATURE": paymentSignature,
          }),
        );
        if (res.ok) this.recordSpend(usd);
      } finally {
        // Settled ops moved their amount into sessionSpentUsd; failed ones charged
        // nothing. Either way the in-flight reservation ends here, so a throw cannot
        // leak budget.
        release();
      }
    }

    if (!res.ok) throw await this.asError(res, label);
    return spec.parseSuccess(res);
  }

  protected requireSigner(): Signer {
    if (!this.signer) {
      throw new AgentRagError(
        "a wallet signer is required for this operation",
        "invalid_config",
        0,
      );
    }
    return this.signer;
  }

  /**
   * Ask a question over a collection, ingesting `sources` on demand when the target
   * collection doesn't exist yet (or `refresh` is set). Paid per call: the flat
   * `ASK_BASE_USD` when no ingest is needed, or a composite ingest-denominated charge
   * (spec §11.3) when `sources` triggers one — `askAuthorizedCeilingUsd` computes the
   * ceiling this SDK authorizes from its OWN pinned prices, BEFORE the 402 challenge is
   * even read, so an inflated or spoofed quote is refused pre-signature (see performOp).
   *
   * A 202 (the collection is still being ingested) resolves as `AskPending` — NOT an
   * error. Use `askAndWait` to block until it resolves, or poll `status()` (a later
   * task's public surface) yourself.
   */
  async ask(query: string, opts: AskOptions = {}): Promise<AskResult | AskPending> {
    if (typeof query !== "string" || query.trim().length === 0) {
      throw new AgentRagError(
        "query is required and must be a non-empty string",
        "invalid_request",
        0,
      );
    }
    if (query.length > MAX_QUERY_CHARS) {
      throw new AgentRagError(
        `query must be ${MAX_QUERY_CHARS} characters or less (got ${query.length})`,
        "invalid_request",
        0,
      );
    }
    if (opts.topK !== undefined) {
      if (!Number.isInteger(opts.topK) || opts.topK < 1 || opts.topK > MAX_TOP_K) {
        throw new AgentRagError(
          `topK must be an integer between 1 and ${MAX_TOP_K} (got ${opts.topK})`,
          "invalid_request",
          0,
        );
      }
    }
    if (opts.mode !== undefined && !ASK_MODES.includes(opts.mode)) {
      throw new AgentRagError(
        `mode must be one of ${ASK_MODES.join(", ")} (got ${JSON.stringify(opts.mode)})`,
        "invalid_request",
        0,
      );
    }
    if (opts.maxPages !== undefined) {
      if (
        !Number.isInteger(opts.maxPages) ||
        opts.maxPages < 1 ||
        opts.maxPages > MAX_PAGES_PER_CALL
      ) {
        throw new AgentRagError(
          `maxPages must be an integer between 1 and ${MAX_PAGES_PER_CALL} (got ${opts.maxPages})`,
          "invalid_request",
          0,
        );
      }
    }
    if (opts.sources !== undefined) {
      // M4: mirrors the worker's own parseAskBody ("sources, if present, must be a
      // non-empty array") — an empty array passes the per-entry loop below vacuously
      // (zero iterations) and would otherwise reach the network only to be 400'd,
      // burning a real EIP-3009 signature in wallet mode first.
      if (opts.sources.length === 0) {
        throw new AgentRagError(
          "sources, if present, must be a non-empty array",
          "invalid_request",
          0,
        );
      }
      for (const source of opts.sources) assertValidSource(source);
    }
    if (opts.sources === undefined && opts.collection === undefined) {
      throw new AgentRagError(
        "at least one of sources or collection is required",
        "invalid_request",
        0,
      );
    }

    const body: Record<string, unknown> = { query };
    if (opts.sources !== undefined) body.sources = opts.sources;
    if (opts.collection !== undefined) body.collection = opts.collection;
    if (opts.topK !== undefined) body.top_k = opts.topK;
    if (opts.mode !== undefined) body.mode = opts.mode;
    if (opts.maxPages !== undefined) body.max_pages = opts.maxPages;
    if (opts.refresh !== undefined) body.refresh = opts.refresh;

    const effectiveMaxPages = opts.maxPages ?? DEFAULT_ASK_MAX_PAGES;

    return this.performOp<AskResult | AskPending>({
      method: "POST",
      path: "/v1/rag/ask",
      url: `${this.endpoint}/v1/rag/ask`,
      idempotencyKey: opts.idempotencyKey ?? freshNonce(),
      label: "ask failed",
      authorizedCeilingUsd: askAuthorizedCeilingUsd(opts.sources, effectiveMaxPages),
      buildRequest: (headers) => ({
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
      parseSuccess: async (res) => {
        // C1 fix: the worker wraps every success body in `{ data, request_id, usage? }`
        // (`dataResponse`, the service's HTTP envelope helper) — `data` carries the
        // verb-specific fields (AskResult's or AskPending's own shape), `usage` and
        // `request_id` are envelope-level siblings, NOT nested inside `data`. Parsing
        // this flat (as the prior round did) leaves every `data`-half field
        // `undefined` at runtime despite typechecking fine against AskResult/AskPending.
        const env = JSON.parse(await res.text()) as {
          data: Omit<
            AskResult | AskPending,
            "usage" | "request_id" | "settledTxHash" | "creditsRemaining"
          >;
          usage?: AskResult["usage"];
          request_id?: string;
        };
        // Cast needed: TS spreads a UNION-typed value conservatively, keeping only
        // properties common to EVERY union member (here just `collection`) as certain
        // — it does not re-verify the result against AskResult | AskPending on its
        // own. The shape is already pinned by `env`'s own type assertion above; this
        // cast just carries that same trust through the spread, not a new one.
        return {
          ...(env as unknown as AskResult),
          usage: env.usage,
          request_id: env.request_id,
          settledTxHash: settledTxHash(res),
          creditsRemaining: creditsRemaining(res),
        } as AskResult | AskPending;
      },
    });
  }

  /**
   * `ask`, but transparently waits out a 202 instead of returning `AskPending`: polls
   * this collection's ingest-job state until it leaves `running`, then re-asks against
   * the now-resolved collection directly — dropping `sources`/`maxPages`/`refresh` on
   * the retry, since re-sending them would re-quote (and, in wallet mode, re-sign) a
   * full composite ingest charge for work that is already done. A fresh idempotency key
   * is used for the retry too (never the original ask's), since it is a structurally
   * different request body — reusing the same key risks `idempotency_conflict`.
   *
   * Throws `ingest_timeout` at `maxWaitMs` (default `DEFAULT_ASK_WAIT_MS`); the job
   * itself keeps running server-side regardless — a timeout here loses patience, not the
   * ingest. `pollIntervalMs`, when omitted, defaults to the 202's own `retry_after`
   * (falling back to `DEFAULT_ASK_POLL_INTERVAL_MS` if that is missing or non-positive).
   *
   * Polling here goes through a MINIMAL internal helper (`pollIngestJobState`) that reads
   * just the one field this method needs — not the full public `status()` surface
   * (validation, error mapping, `CollectionStatus` parsing), which is a later task's job.
   */
  async askAndWait(
    query: string,
    opts: AskOptions & { maxWaitMs?: number; pollIntervalMs?: number } = {},
  ): Promise<AskResult> {
    const { maxWaitMs, pollIntervalMs, ...askOpts } = opts;
    // I1: a non-finite or non-positive maxWaitMs makes `deadline` non-finite, which
    // poisons `remaining` (NaN) downstream — `NaN <= 0` is `false`, so the timeout can
    // NEVER fire, and `Math.min(interval, NaN)` is also NaN, which `setTimeout` treats
    // as 0: an unbounded, zero-delay poll loop (a real signed request each time in
    // wallet mode). Validated here, before the first `ask()`, like every other bound.
    if (maxWaitMs !== undefined && !(Number.isFinite(maxWaitMs) && maxWaitMs > 0)) {
      throw new AgentRagError(
        `maxWaitMs must be a finite positive number of milliseconds (got ${maxWaitMs})`,
        "invalid_request",
        0,
      );
    }
    // pollIntervalMs: 0 is deliberately VALID (poll immediately, no backoff) — only
    // non-finite or negative values are rejected.
    if (pollIntervalMs !== undefined && !(Number.isFinite(pollIntervalMs) && pollIntervalMs >= 0)) {
      throw new AgentRagError(
        `pollIntervalMs must be a finite non-negative number of milliseconds (got ${pollIntervalMs})`,
        "invalid_request",
        0,
      );
    }
    const deadline = Date.now() + (maxWaitMs ?? DEFAULT_ASK_WAIT_MS);

    let result = await this.ask(query, askOpts);
    while (isAskPending(result)) {
      const { collection } = result;
      const serverIntervalMs =
        Number.isFinite(result.retry_after) && result.retry_after > 0
          ? result.retry_after * 1000
          : DEFAULT_ASK_POLL_INTERVAL_MS;
      const interval = Math.max(0, pollIntervalMs ?? serverIntervalMs);

      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new AgentRagError(
            `ask on collection "${collection}" did not finish ingesting within maxWaitMs; ` +
              "it may still complete server-side",
            "ingest_timeout",
            0,
          );
        }
        await sleep(Math.min(interval, remaining));
        const state = await this.pollIngestJobState(collection);
        if (state !== "running") break;
      }

      // Ingest is no longer running (complete or failed) -> re-ask the resolved
      // collection directly. Only retrieval knobs carry over; sources/maxPages/refresh
      // are ingest-only and idempotencyKey must be fresh (see doc comment above).
      result = await this.ask(query, {
        collection,
        topK: askOpts.topK,
        mode: askOpts.mode,
      });
    }
    return result;
  }

  /**
   * Per-attempt auth headers for `pollIngestJobState`. Computed FRESH on every call —
   * I2: core's `fetchWithRetry` calls `build()` once per attempt specifically so
   * per-request material (an identity signature's nonce/timestamp) can be regenerated;
   * a caller that builds headers once and hands the SAME object to every attempt
   * defeats that, reusing one nonce/timestamp across retries. Spread into a fresh object
   * literal so both branches unify on plain Record<string, string> (IdentityHeaders has
   * no index signature of its own).
   */
  protected async pollHeaders(path: string): Promise<Record<string, string>> {
    return this.accountKey
      ? buildBearerHeaders(this.accountKey)
      : {
          ...(await buildIdentityHeaders(this.requireSigner(), {
            method: "GET",
            path,
            host: new URL(this.endpoint).host,
            network: this.network,
          })),
        };
  }

  /**
   * Minimal internal poll of a collection's ingest-job state, used ONLY by `askAndWait`.
   * `GET /v1/rag/collection/:id` is a FREE, identity-signed (or bearer, in account-key
   * mode) route — never x402 — so this bypasses `performOp` (built for the paid dance)
   * entirely. Returns `undefined` when the response's `data` half carries no `job` block
   * (nothing ever ran there), which `askAndWait` treats the same as a terminal state
   * (not "running").
   *
   * NOT the public `status()` surface — that is a later task's job (full
   * `CollectionStatus` parsing, error mapping, public API). This helper reads only the
   * one field `askAndWait` needs; feel free to replace it with a call through the real
   * `status()` once that lands.
   */
  protected async pollIngestJobState(
    collection: string,
  ): Promise<"running" | "complete" | "failed" | undefined> {
    const path = `/v1/rag/collection/${encodeURIComponent(collection)}`;
    const res = await this.fetchWithRetry(`${this.endpoint}${path}`, async () => ({
      method: "GET",
      headers: await this.pollHeaders(path),
    }));
    if (!res.ok) throw await this.asError(res, "collection status failed");
    // C2 fix: this route's success body is ALSO the `{ data, request_id }` envelope
    // (`routeCollectionStatus` returns `dataResponse(200, statusData(meta), requestId)`,
    // and `statusData` nests `job` inside its own `data` half) — `body.job` is always
    // `undefined`. The prior round's bug: `askAndWait` treats `undefined` as terminal,
    // so it exited the wait after exactly one poll regardless of the job's real state.
    const body = (await res.json()) as {
      data?: { job?: { state: "running" | "complete" | "failed" } };
    };
    return (body as unknown as { job?: { state: "running" | "complete" | "failed" } }).job?.state;
  }
}
