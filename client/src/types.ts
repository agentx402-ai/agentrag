import type { Signer, UsageBlock } from "@agentx402-ai/core";

export type { Signer, UsageBlock };

// TEMPORARY WORKAROUND (tracked in the task list as "Release core 0.4.0
// (breakdown/expiring_soon)", owner-gated; ruling confirmed independently by the
// controller, who verified the installed node_modules/@agentx402-ai/core/dist/index.d.ts
// directly): the PUBLISHED @agentx402-ai/core@0.3.0 predates the commit that added
// `breakdown`/`expiring_soon` to UsageBlock on core's own main branch — core's
// package.json was never bumped off 0.3.0, so npm's 0.3.0 lacks fields core's own source
// already carries. The service genuinely emits a breakdown leg on a composite ask (the
// worker's ask route wraps its response in `withBreakdown`), so the client must model it
// today rather than wait for the release. `UsageBlock` above stays a PLAIN, unmodified
// re-export of core's own type (for compatibility with anything typed against core
// directly); `RagUsageBlock` below is an ADDITIONAL, superset export — extended, never
// redeclared, so the two cannot drift — used wherever this SDK's own wire responses
// actually carry the two fields. Once core ships 0.4.0 with these fields natively, fold
// them back: replace each `RagUsageBlock` usage with `UsageBlock` and delete this interface.
export interface RagUsageBlock extends UsageBlock {
  /**
   * Composite-op itemization: additional charge legs beyond the primary verb (e.g. an
   * AgentRAG ask that also ingested pages). The top-level `price_usd` is the PRIMARY
   * verb's price on the taken path; the request's total cost is `price_usd` + the sum of
   * `breakdown[].price_usd`. Absent on single-leg ops — never an empty array on the wire.
   * Mirrors core's own (unreleased) UsageBlock.breakdown field-for-field.
   */
  breakdown?: Array<{ op: string; units: number; price_usd: number }>;
  /**
   * Present (always literal `true`, never `false`) when the collection named by this
   * response is inside the final 24h of its lifetime — the caller's cue to query it
   * (sliding the expiry) or extend it. Omitted otherwise. Mirrors core's own (unreleased)
   * UsageBlock.expiring_soon field-for-field.
   */
  expiring_soon?: true;
}

/** Embedding model backing a collection. Fixed at collection creation — an `ingest` against
 * an existing collection with a different model is rejected server-side (model_mismatch). */
export type RagModelId =
  | "@cf/baai/bge-m3"
  | "@cf/baai/bge-large-en-v1.5"
  | "@cf/qwen/qwen3-embedding-0.6b"
  | "@cf/google/embeddinggemma-300m";

export interface AgentRagOptions {
  /** REQUIRED. Absolute http(s) URL, validated at construction. Trailing slashes trimmed. */
  endpoint: string;
  /** Wallet (x402) mode: a raw EVM private key. Mutually exclusive with `signer` and with
   * `accountKey`. */
  privateKey?: `0x${string}`;
  /** Wallet (x402) mode: bring your own signer instead of a raw key. Alternative to `privateKey`. */
  signer?: Signer;
  /** Bearer (credit) mode: an `ak_…` account key. Mutually exclusive with wallet mode. */
  accountKey?: string;
  /** CAIP-2 network id. Default "eip155:8453" (Base mainnet). */
  network?: string;
  /** Per-paying-call USD ceiling on the server-quoted price; throws SpendCapError if exceeded. */
  maxSpendUsd?: number;
  /** Cumulative USD ceiling across this client (best-effort in-memory counter). */
  maxSessionSpendUsd?: number;
  /**
   * Pin the x402 payment recipient. Any 402 challenge whose payTo differs is rejected
   * (payto_mismatch) BEFORE the EIP-3009 authorization is signed.
   */
  expectedPayTo?: `0x${string}`;
  /** Bounded retries on TRANSIENT failures (thrown fetch / 5xx / 429). */
  maxRetries?: number;
  /** Per-attempt request timeout in ms. */
  timeoutMs?: number;
  /** Injectable fetch for proxies / instrumentation / tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/** One retrieved passage. */
export interface RagChunk {
  text: string;
  score: number;
  url: string | null;
  title: string | null;
  /** The chunk's ordinal position within its source document. */
  position: number;
}

/** Ingest progress snapshot — surfaced inline on `AskResult.ingest` (a background top-up
 * observed alongside an answer) and standalone via `CollectionStatus.job`. */
export interface IngestProgress {
  status: string;
  pages_done?: number;
  pages_total?: number;
  pages_ok?: number;
  pages_failed?: number;
}

export interface AskOptions {
  /** Sources to ingest before answering, when the target collection doesn't exist yet or
   * `refresh` is set. Each an exact http(s) URL or a trailing-`/**` same-origin crawl root. */
  sources?: string[];
  /** Target an existing named collection instead of one derived from `sources`. */
  collection?: string;
  /** Number of chunks to retrieve. Integer 1..MAX_TOP_K — rejected client-side, never clamped. */
  topK?: number;
  mode?: "hybrid" | "dense" | "bm25";
  /** Cap on pages ingested by this call. Integer 1..MAX_PAGES_PER_CALL. */
  maxPages?: number;
  /** Force re-ingestion even if the collection already exists. */
  refresh?: boolean;
  idempotencyKey?: string;
}

export interface AskResult {
  collection: string;
  expires_at: string;
  matched: boolean;
  chunks: RagChunk[];
  /** Present when this ask also triggered or observed a background ingest. */
  ingest?: IngestProgress;
  usage?: RagUsageBlock;
  request_id?: string;
  /**
   * On-chain settlement txHash for this op, or `""` when it settled on credits (nothing
   * moved on-chain) or the worker sent no `PAYMENT-RESPONSE` header. See `settledTxHash()`
   * in payment.ts — always computed, never fabricated.
   */
  settledTxHash: string;
  /**
   * Prepaid-credit balance remaining after this op. `undefined` when no real balance was
   * read this call (never coerced from a genuine 0 — see `creditsRemaining()` in payment.ts).
   */
  creditsRemaining?: number;
}

/** A 202 response: the collection is still being ingested. Not an error — poll `status()` or
 * use `askAndWait`. */
export interface AskPending {
  collection: string;
  status: "ingesting";
  pages_done: number;
  pages_total: number;
  /** Seconds to wait before polling again. */
  retry_after: number;
  /**
   * Present only on `ingest`'s 202, which settles its charge before returning.
   * `ask`'s 202 computes usage later in the request and therefore sends none.
   */
  usage?: RagUsageBlock;
  request_id?: string;
  /**
   * On-chain settlement txHash for a charge ALREADY settled before this 202 (e.g. an
   * ask's on-demand ingest leg) — `""` when nothing has settled on-chain yet. Mirrors
   * `AskResult.settledTxHash`; see `settledTxHash()` in payment.ts.
   */
  settledTxHash: string;
  /** Mirrors `AskResult.creditsRemaining`; see `creditsRemaining()` in payment.ts. */
  creditsRemaining?: number;
}

export interface IngestDocument {
  text: string;
  title?: string;
  url?: string;
}

export interface IngestOptions {
  sources?: string[];
  documents?: IngestDocument[];
  collection?: string;
  /** Fixed at collection creation; omit to use DEFAULT_MODEL. */
  model?: RagModelId;
  maxPages?: number;
  refresh?: boolean;
  idempotencyKey?: string;
}

export interface IngestResult {
  collection: string;
  status: string;
  pages_total: number;
  pages_failed: number;
  chunks: number;
  expires_at: string;
  usage?: RagUsageBlock;
  request_id?: string;
  /** Mirrors `AskResult.settledTxHash` — populate from `settledTxHash()` in payment.ts. */
  settledTxHash: string;
  /** Mirrors `AskResult.creditsRemaining` — populate from `creditsRemaining()` in payment.ts. */
  creditsRemaining?: number;
}

export interface ExtendResult {
  collection: string;
  expires_at: string;
  usage?: RagUsageBlock;
  request_id?: string;
  /** Mirrors `AskResult.settledTxHash` — populate from `settledTxHash()` in payment.ts. */
  settledTxHash: string;
  /** Mirrors `AskResult.creditsRemaining` — populate from `creditsRemaining()` in payment.ts. */
  creditsRemaining?: number;
}

/** Returned by the identity-signed, free `status()` op. */
export interface CollectionStatus {
  collection: string;
  model: string;
  pages: number;
  chunks: number;
  created_at: string;
  expires_at: string;
  job?: {
    pages_done: number;
    pages_total: number;
    state: "running" | "complete" | "failed";
  };
  request_id?: string;
}
