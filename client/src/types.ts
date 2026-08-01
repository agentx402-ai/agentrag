import type { Signer, UsageBlock } from "@agentx402-ai/core";

export type { Signer, UsageBlock };

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
  usage?: UsageBlock;
  request_id?: string;
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
  usage?: UsageBlock;
  request_id?: string;
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
  usage?: UsageBlock;
  request_id?: string;
}

export interface ExtendResult {
  collection: string;
  expires_at: string;
  usage?: UsageBlock;
  request_id?: string;
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
