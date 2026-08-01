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
  buildPaymentHeader,
  challengePriceUsd,
  nonceFromIdempotencyKey,
} from "./payment";
import type { AgentRagOptions, RagModelId, Signer } from "./types";

export { generateAccountKey, isAccountKeyFormat } from "./account";
export {
  AgentRagError,
  AgentXError,
  type RagErrorCode,
  ragErrorFromResponse,
  SpendCapError,
} from "./errors";
export * from "./types";

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
export const MAX_DOCUMENT_BYTES = 100_000;

const DEFAULT_NETWORK = "eip155:8453";

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
}
