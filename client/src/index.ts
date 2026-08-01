import {
  assertFiniteUsd as coreAssertFiniteUsd,
  fetchWithRetry as coreFetchWithRetry,
  SpendLedger,
} from "@agentx402-ai/core";
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { isAccountKeyFormat } from "./account";
import { assertValidCollectionName, collectionPath } from "./collection";
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
import {
  askAuthorizedCeilingUsd,
  extendAuthorizedCeilingUsd,
  ingestAuthorizedCeilingUsd,
} from "./pricing";
import type {
  AgentRagOptions,
  AskOptions,
  AskPending,
  AskResult,
  CollectionStatus,
  ExtendResult,
  IngestDocument,
  IngestOptions,
  IngestResult,
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

/**
 * The service's own embedding-model catalog, mirrored here as a runtime-checkable array so
 * `ingest()` can reject an unknown `model` client-side (see its own validation) — the same
 * M4 rationale as `assertValidSource`/`assertValidDocuments`: a typo'd model id still gets a
 * clean 400 today, but rejecting it before any request avoids burning a real EIP-3009
 * signature in wallet mode on a request the worker was always going to refuse.
 *
 * Unlike `ask()`'s `mode` enum, this is NOT a stale-allowlist risk: the worker's model table
 * is a hardcoded compile-time record keyed by exactly these four ids, and each entry pins a
 * fixed embedding dimension plus a specific Vectorize index binding — a fifth model requires
 * a worker code change, a deploy, and (for a new dimension) a new index, never a silent
 * server-side addition the SDK could fall behind on unnoticed. `satisfies readonly
 * RagModelId[]` is a compile-time check that every entry here is a real `RagModelId` (catches
 * a typo at build time, before it ever reaches a runtime check). Task 14 (cross-repo parity)
 * should compare this array against the worker's own model catalog keys, the same
 * "duplicated by contract, cross-checked by CI" pattern already used for every other
 * price/limit this SDK mirrors.
 */
export const RAG_MODELS = [
  "@cf/baai/bge-m3",
  "@cf/baai/bge-large-en-v1.5",
  "@cf/qwen/qwen3-embedding-0.6b",
  "@cf/google/embeddinggemma-300m",
] as const satisfies readonly RagModelId[];

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
// Mirrors the worker's own `mode` enum.
const ASK_MODES = ["hybrid", "dense", "bm25"] as const;
// Mirrors the worker's own `max_pages` default — used ONLY to size the authorized-ceiling
// formula when the caller omits `maxPages`; the wire request itself omits `max_pages` too
// in that case, so the worker applies this same default.
const DEFAULT_ASK_MAX_PAGES = 20;
// ingest's OWN `max_pages` default — independently declared server-side (ingest.ts's own
// inline `let maxPages = 20`), not sourced from DEFAULT_ASK_MAX_PAGES above. Same numeric
// value as ask's default today by coincidence, not by a shared constant — mirrors the
// worker's own two routes, which each inline their own default rather than importing one
// from the other (see ingest.ts's worstCaseIngestPages doc comment for the identical
// duplicate-rather-than-couple rationale).
const DEFAULT_INGEST_MAX_PAGES = 20;

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
 * Mirrors the worker's own source-grammar validation so a malformed source is rejected
 * client-side before any request: an exact http(s) URL, or
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

/**
 * Mirrors the worker's own per-document validation (ingest.ts's `parseIngestBody`): the
 * array must be non-empty overall, contain at most MAX_DOCUMENTS entries, and each entry's
 * `text` must be no larger than MAX_DOCUMENT_BYTES — measured the SAME way the worker
 * measures it (`TextEncoder().encode(text).length`, i.e. UTF-8 bytes, not JS string length;
 * a multi-byte character would otherwise let a client-accepted document exceed the server's
 * real limit). Rejected client-side, before any request — burning a real EIP-3009 signature
 * in wallet mode on a document set the server would 400 anyway is exactly the M4 waste this
 * SDK's other pre-request validators (see `assertValidSource`) exist to prevent.
 *
 * Deliberately does NOT validate `title`/`url` shape (also checked server-side): both are
 * free-form strings with no size/count ceiling of their own, so a bad value there doesn't
 * waste a signature the way an oversized/overcounted `documents` set does — the server's
 * own 400 is cheap for that case, unlike this one.
 */
function assertValidDocuments(documents: IngestDocument[]): void {
  if (documents.length === 0) {
    throw new AgentRagError(
      "documents, if present, must be a non-empty array",
      "invalid_request",
      0,
    );
  }
  if (documents.length > MAX_DOCUMENTS) {
    throw new AgentRagError(
      `documents must contain at most ${MAX_DOCUMENTS} items (got ${documents.length})`,
      "invalid_request",
      0,
    );
  }
  const encoder = new TextEncoder();
  documents.forEach((doc, i) => {
    if (typeof doc.text !== "string") {
      throw new AgentRagError(
        `documents[${i}].text is required and must be a string`,
        "invalid_request",
        0,
      );
    }
    const bytes = encoder.encode(doc.text).length;
    if (bytes > MAX_DOCUMENT_BYTES) {
      throw new AgentRagError(
        `documents[${i}].text must be at most ${MAX_DOCUMENT_BYTES} bytes (got ${bytes})`,
        "invalid_request",
        0,
      );
    }
  });
}

/** Type guard distinguishing a 202 (`AskPending`) from a settled `AskResult`. */
function isAskPending(result: AskResult | AskPending): result is AskPending {
  return (result as AskPending).status === "ingesting";
}

/**
 * The verb-specific half of a paid response's envelope (the service's own wire contract
 * wraps every success body as `{ data, request_id, usage? }`; this is `data`'s shape).
 * A plain `Omit<T, K>` does NOT distribute over a union: `keyof (A | B)` is the
 * INTERSECTION of `keyof A` and `keyof B` (TypeScript can only guarantee a property exists
 * on a union-typed value if every member has it), so `Omit<AskResult | AskPending, K>`
 * collapses to just the few keys the two interfaces happen to share after removing `K` —
 * here, only `collection` — silently discarding `chunks`/`matched`/`expires_at` (AskResult)
 * and `status`/`pages_done`/`pages_total`/`retry_after` (AskPending) from the type. The
 * `T extends unknown ? ... : never` form below IS a distributive conditional type (a naked
 * type parameter in a conditional distributes), so `DataOf<AskResult | AskPending>`
 * correctly evaluates to `Omit<AskResult, K> | Omit<AskPending, K>` — a proper union
 * retaining each branch's own fields. Reused below (not just by `ask()`) for every other
 * verb's own envelope unwrap — `ingest()`'s `IngestResult | AskPending`, `extend()`'s
 * `ExtendResult`, and `status()`'s `CollectionStatus` all go through the identical
 * mechanism, whether or not their own return type happens to be a union.
 */
type DataOf<T> = T extends unknown
  ? Omit<T, "usage" | "request_id" | "settledTxHash" | "creditsRemaining">
  : never;

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
   * error. Use `askAndWait` to block until it resolves, or poll `status()` yourself.
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
        // C1 fix: the service wraps every success body in `{ data, request_id, usage? }`
        // — `data` carries the verb-specific fields (AskResult's or AskPending's own
        // shape), `usage` and `request_id` are envelope-level siblings, NOT nested
        // inside `data`. Parsing this flat (as an earlier round did) leaves every
        // `data`-half field `undefined` at runtime despite typechecking fine against
        // AskResult/AskPending. `data: DataOf<AskResult | AskPending>` (not a bare
        // `Omit<AskResult | AskPending, ...>`, which does not distribute over the
        // union — see DataOf's own doc comment) keeps the compiler checking this
        // spread for real, so a future edit back to an unwrapped `...env` is a type
        // error, not merely a fixture failure.
        const env = JSON.parse(await res.text()) as {
          data: DataOf<AskResult | AskPending>;
          usage?: AskResult["usage"];
          request_id?: string;
        };
        return {
          ...env.data,
          usage: env.usage,
          request_id: env.request_id,
          settledTxHash: settledTxHash(res),
          creditsRemaining: creditsRemaining(res),
        };
      },
    });
  }

  /**
   * `ask`, but transparently waits out a 202 instead of returning `AskPending`: polls
   * this collection's ingest-job state until it leaves `running`, then re-asks against
   * the now-resolved collection directly — dropping `sources`/`maxPages`/`refresh` on
   * the retry, since re-sending them would re-quote (and, in wallet mode, re-sign) a
   * full composite ingest charge for work that is already done.
   *
   * I2: the re-ask's idempotency key is DERIVED from the caller's own (`${key}:ask`),
   * not reused verbatim and not dropped.
   *
   * Reusing the key verbatim is NOT an `idempotency_conflict` risk (a wrong claim an
   * earlier version of this comment made) — the platform's charge-conflict fingerprint
   * is service+verb only, so two `ask()` calls can never collide on it regardless of
   * body or amount.
   *
   * The real, narrower constraint: in wallet mode, `nonceFromIdempotencyKey`
   * deterministically seeds the signed EIP-3009 authorization's nonce FROM the
   * idempotency key, so presenting the SAME key again re-signs with the SAME nonce as
   * the original ask's own payment. Recovery from an already-used nonce is gated
   * ON-CHAIN against the PINNED AMOUNT — a same-amount retry recovers cleanly (no
   * second charge), but the re-ask can legitimately settle a DIFFERENT amount than the
   * original ask, and a mismatched-amount reuse lands on a THROWING (retryable) path
   * instead — never a silent free success. Deriving a distinct-but-stable key avoids
   * depending on that path at all: a caller who supplies their OWN `idempotencyKey`
   * gets exactly-once coverage on the leg that actually bills (the re-ask), not only on
   * the initial, possibly-still-pending call — while a caller who supplies none still
   * gets a fresh nonce per call, unchanged.
   *
   * Throws `ingest_timeout` at `maxWaitMs` (default `DEFAULT_ASK_WAIT_MS`); the job
   * itself keeps running server-side regardless — a timeout here loses patience, not the
   * ingest. `pollIntervalMs`, when omitted, defaults to the 202's own `retry_after`
   * (falling back to `DEFAULT_ASK_POLL_INTERVAL_MS` if that is missing or non-positive).
   *
   * Polling here goes through a MINIMAL internal helper (`pollIngestJobState`) that reads
   * just the one field this method needs, delegating to the public `status()` below for
   * the actual request/parse (Task 6) rather than duplicating it.
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
    // I2: computed once, outside the loop — askOpts.idempotencyKey doesn't change across
    // iterations. `undefined` (not a derived string) when the caller supplied none, so
    // the re-ask falls through to ask()'s own `?? freshNonce()` exactly as before.
    const reAskIdempotencyKey =
      askOpts.idempotencyKey !== undefined ? `${askOpts.idempotencyKey}:ask` : undefined;

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
      // are ingest-only. I2: idempotencyKey is DERIVED (see doc comment above), not
      // reused verbatim and not dropped — see reAskIdempotencyKey's own comment.
      result = await this.ask(query, {
        collection,
        topK: askOpts.topK,
        mode: askOpts.mode,
        idempotencyKey: reAskIdempotencyKey,
      });
    }
    return result;
  }

  /**
   * Explicit pre-warm / raw-document ingest, and the only way to index `documents` (text
   * with no URL) or force a `refresh` re-fetch. Paid per call, PER PAGE/PER DOCUMENT unit
   * (never composite the way `ask`'s on-demand ingest leg is) — `ingestAuthorizedCeilingUsd`
   * computes the ceiling this SDK authorizes from its OWN pinned prices and the request's
   * worst-case page count, BEFORE the 402 challenge is even read, so an inflated or spoofed
   * quote is refused pre-signature (see performOp).
   *
   * A source set naming a crawl root or more than 3 new/refreshed exact urls needs a
   * durable job server-side and resolves as `AskPending` (a 202: `status: "ingesting"`) —
   * NOT an error, same shape `ask()`'s own on-demand ingest leg returns. A small source set
   * and/or `documents` resolve inline as an `IngestResult` (200).
   */
  async ingest(opts: IngestOptions): Promise<IngestResult | AskPending> {
    if (opts.sources !== undefined) {
      // Mirrors ask()'s own M4 check: an empty array passes a per-entry loop vacuously and
      // would otherwise reach the network only to be 400'd server-side.
      if (opts.sources.length === 0) {
        throw new AgentRagError(
          "sources, if present, must be a non-empty array",
          "invalid_request",
          0,
        );
      }
      for (const source of opts.sources) assertValidSource(source);
    }
    if (opts.documents !== undefined) assertValidDocuments(opts.documents);
    if (opts.sources === undefined && opts.documents === undefined) {
      throw new AgentRagError(
        "at least one of sources or documents is required",
        "invalid_request",
        0,
      );
    }
    if (opts.collection !== undefined) assertValidCollectionName(opts.collection);
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
    // Mirrors ask()'s `mode` enum check (see RAG_MODELS's own doc comment for why this,
    // unlike that enum, carries no stale-allowlist risk: the worker's model catalog can't
    // drift ahead of a coordinated SDK release either).
    if (opts.model !== undefined && !RAG_MODELS.includes(opts.model)) {
      throw new AgentRagError(
        `model must be one of ${RAG_MODELS.join(", ")} (got ${JSON.stringify(opts.model)}); ` +
          "omit model to inherit the target collection's own",
        "invalid_request",
        0,
      );
    }

    const body: Record<string, unknown> = {};
    if (opts.sources !== undefined) body.sources = opts.sources;
    if (opts.documents !== undefined) body.documents = opts.documents;
    if (opts.collection !== undefined) body.collection = opts.collection;
    if (opts.model !== undefined) body.model = opts.model;
    if (opts.maxPages !== undefined) body.max_pages = opts.maxPages;
    if (opts.refresh !== undefined) body.refresh = opts.refresh;

    const effectiveMaxPages = opts.maxPages ?? DEFAULT_INGEST_MAX_PAGES;

    return this.performOp<IngestResult | AskPending>({
      method: "POST",
      path: "/v1/rag/ingest",
      url: `${this.endpoint}/v1/rag/ingest`,
      idempotencyKey: opts.idempotencyKey ?? freshNonce(),
      label: "ingest failed",
      authorizedCeilingUsd: ingestAuthorizedCeilingUsd(
        opts.sources,
        opts.documents?.length ?? 0,
        effectiveMaxPages,
      ),
      buildRequest: (headers) => ({
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
      parseSuccess: async (res) => {
        // Same envelope-unwrap discipline as ask() — see DataOf's own doc comment and
        // ask()'s C1-fix comment for why a bare `...env` (no `data` unwrap) would silently
        // typecheck while leaving every field undefined at runtime.
        const env = JSON.parse(await res.text()) as {
          data: DataOf<IngestResult | AskPending>;
          usage?: IngestResult["usage"];
          request_id?: string;
        };
        return {
          ...env.data,
          usage: env.usage,
          request_id: env.request_id,
          settledTxHash: settledTxHash(res),
          creditsRemaining: creditsRemaining(res),
        };
      },
    });
  }

  /**
   * Push a named collection's `expires_at` out by `days` (30/60/90) without querying it
   * first. Paid per call: `ceil(chunks / CHUNKS_PER_BLOCK)` blocks (min 1) times
   * `days / 30`, at the per-block extend price. `extendAuthorizedCeilingUsd(days)` (its
   * `chunks` defaulted, since this method takes no such argument) authorizes exactly the
   * worker's own stateless 1-block-per-30-days quote — see that function's own doc comment
   * for why this is an EXACT match on a collection of any real size, never merely a safe
   * underestimate: the worker's pre-auth 402 challenge never reveals or depends on the
   * collection's real chunk count, by design.
   */
  async extend(collection: string, days: 30 | 60 | 90): Promise<ExtendResult> {
    assertValidCollectionName(collection);
    if (days !== 30 && days !== 60 && days !== 90) {
      throw new AgentRagError(`days must be one of 30, 60, 90 (got ${days})`, "invalid_request", 0);
    }

    const body = { collection, days };

    return this.performOp<ExtendResult>({
      method: "POST",
      path: "/v1/rag/extend",
      url: `${this.endpoint}/v1/rag/extend`,
      idempotencyKey: freshNonce(),
      label: "extend failed",
      authorizedCeilingUsd: extendAuthorizedCeilingUsd(days),
      buildRequest: (headers) => ({
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
      parseSuccess: async (res) => {
        const env = JSON.parse(await res.text()) as {
          data: DataOf<ExtendResult>;
          usage?: ExtendResult["usage"];
          request_id?: string;
        };
        return {
          ...env.data,
          usage: env.usage,
          request_id: env.request_id,
          settledTxHash: settledTxHash(res),
          creditsRemaining: creditsRemaining(res),
        };
      },
    });
  }

  /**
   * Per-attempt auth headers for a FREE, identity-signed (or bearer, in account-key mode)
   * collection op — `status()`, `delete()`, and (through `status()`) `askAndWait`'s
   * internal poll. Computed FRESH on every call: core's `fetchWithRetry` calls `build()`
   * once per attempt specifically so per-request material (an identity signature's
   * nonce/timestamp) can be regenerated; a caller that builds headers once and hands the
   * SAME object to every attempt defeats that, reusing one nonce/timestamp across
   * retries — `pollIngestJobState` (the predecessor of this method, before it delegated to
   * `status()`) already established the pattern this follows.
   *
   * `method` MUST be the request's REAL verb (GET for status, DELETE for delete) — EIP-712
   * identity is verified against the actual request method + path, so a hardcoded method
   * here would make e.g. a DELETE's signature fail verification.
   */
  protected async identityOrBearerHeaders(
    method: "GET" | "DELETE",
    path: string,
  ): Promise<Record<string, string>> {
    return this.accountKey
      ? buildBearerHeaders(this.accountKey)
      : {
          ...(await buildIdentityHeaders(this.requireSigner(), {
            method,
            path,
            host: new URL(this.endpoint).host,
            network: this.network,
          })),
        };
  }

  /**
   * Free, identity-signed (or bearer, in account-key mode) collection metadata read —
   * owner-gated. The worker returns the SAME 404 `collection_not_found` for an absent
   * collection and one owned by someone else (no existence oracle), and 410
   * `collection_expired` for an expired-but-unpurged collection the caller genuinely owns.
   */
  async status(collection: string): Promise<CollectionStatus> {
    assertValidCollectionName(collection);
    const path = collectionPath(collection);
    const res = await this.fetchWithRetry(`${this.endpoint}${path}`, async () => ({
      method: "GET",
      headers: await this.identityOrBearerHeaders("GET", path),
    }));
    if (!res.ok) throw await this.asError(res, "collection status failed");
    const env = JSON.parse(await res.text()) as {
      data: DataOf<CollectionStatus>;
      request_id?: string;
    };
    return { ...env.data, request_id: env.request_id };
  }

  /**
   * Free, identity-signed (or bearer) immediate purge of an owned collection. Same
   * no-existence-oracle / 410-for-the-true-owner semantics as `status()`.
   */
  async delete(collection: string): Promise<{ deleted: true }> {
    assertValidCollectionName(collection);
    const path = collectionPath(collection);
    const res = await this.fetchWithRetry(`${this.endpoint}${path}`, async () => ({
      method: "DELETE",
      headers: await this.identityOrBearerHeaders("DELETE", path),
    }));
    if (!res.ok) throw await this.asError(res, "collection delete failed");
    const env = JSON.parse(await res.text()) as {
      data: { deleted: true };
      request_id?: string;
    };
    return env.data;
  }

  /**
   * Minimal internal poll of a collection's ingest-job state, used ONLY by `askAndWait`.
   * Delegates to the public `status()` above (Task 6) and reads just the one field this
   * method needs — `undefined` when the response carries no `job` block (nothing ever ran
   * there), which `askAndWait` treats the same as a terminal state (not "running").
   */
  protected async pollIngestJobState(
    collection: string,
  ): Promise<"running" | "complete" | "failed" | undefined> {
    const result = await this.status(collection);
    return result.job?.state;
  }
}
