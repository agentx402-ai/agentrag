import type { Signer, UsageBlock } from "@agentx402-ai/core";

export type { Signer, UsageBlock };

// `RagUsageBlock` is now a plain alias for core's `UsageBlock`.
//
// It began as a superset: `breakdown`/`expiring_soon` existed on core's main branch but not
// in any PUBLISHED core, because core's package.json was never bumped off 0.3.0. The service
// genuinely emits a breakdown leg on a composite ask, so this SDK modelled the two fields
// itself rather than wait. Core 0.4.0 shipped both natively on 2026-08-08 and this package's
// floor is `^0.4.0`, so the superset had nothing left to add — verified field-for-field
// against the installed core: `breakdown?: Array<{op, units, price_usd}>` and
// `expiring_soon?: true` (the literal type, not `boolean`).
//
// Collapsing it is not a breaking change. The name is INTERNAL — it never carried an
// `export`, so no consumer can have imported it; it reaches them only structurally, through
// `AskResult["usage"]` and friends. (An earlier version of this comment asserted the
// opposite — that the name was permanently public API — which was simply wrong about its
// own file.) An alias to a structurally identical shape is transparent either way.
//
// `UsageBlock` above stays a plain, unmodified re-export of core's type. The two names now
// resolve to the same thing by construction rather than by discipline, which is the point:
// agentscout and agentkv both re-export core's UsageBlock directly, and AgentRAG was the
// only client still carrying a local superset.
type RagUsageBlock = UsageBlock;

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

/** One page that did not make it into the collection. */
export interface RagPageFailure {
  /** The page's url, or `null` for a document ingested without one. */
  url: string | null;
  /**
   * Why it failed.
   *
   * The CATEGORIES are a closed list — `thin_content`, `no_chunks`, `body_too_large`,
   * `collection_expired`, `refresh_delete_failed`, `upstream_status_<code>`,
   * `fetch_failed:<detail>`, plus one generic token for an internal error (whose message
   * is deliberately never echoed). The concrete STRINGS are not closed, because the last
   * two carry a variable suffix.
   *
   * So match with `startsWith`, never exhaustively: a `switch` over today's values is
   * wrong the first time an unusual upstream status appears. This is deliberately NOT one
   * of the `RagErrorCode` values — it describes one page's fate, not the request's
   * outcome.
   *
   * `upstream_status_402` is worth knowing by name: it means a toll-gated source. AgentRAG
   * fetches through AgentScout with no toll budget, so a paywalled page fails closed
   * rather than being paid for.
   */
  reason: string;
}

/**
 * The failure-shaped half of any ingest progress report. Shared by all three surfaces
 * that carry one — `AskResult.ingest`, `AskPending`, `CollectionStatus.job` — because
 * the server projects all three from a single mapping and the client should not
 * hand-roll three copies that can drift apart.
 *
 * Every field is optional: a collection whose job predates these fields still returns a
 * progress block without them, and no migration exists (or is possible) for it.
 */
export interface IngestFailureDetail {
  /** Pages successfully indexed. `pages_done` counts pages ATTEMPTED, so this is what
   * distinguishes "50 ingested" from "50 attempted, every one failed". */
  pages_ok?: number;
  pages_failed?: number;
  /**
   * Credits minted back for pages that were charged but never indexed.
   *
   * Present on BOTH terminal states. On a FAILED job that is the point: an
   * ingest that dies after starting refunds its unspent budget automatically,
   * and a caller who paid should see that rather than infer it from a balance.
   *
   * Credits, not USDC — a caller who paid in USDC is made whole in store credit
   * at the rate their charge actually settled through.
   *
   * `0` means nothing was owed back (every charged page was indexed). Absent
   * means an older service that cannot say — the two are different answers.
   */
  refunded_credits?: number;
  /**
   * Per-page reasons, capped server-side at 20 across the whole job. `pages_failed`
   * stays the authoritative count — on a large wholesale failure this array is SHORTER
   * than it, so never read `failures.length` as the number of failures.
   */
  failures?: RagPageFailure[];
  /**
   * Set when the run stopped before exhausting its input. The two values imply opposite
   * fixes: `collection_full` means resubmit smaller or `extend()`; `collection_expired`
   * means re-ingest from scratch.
   */
  stopped?: "collection_full" | "collection_expired";
}

/** Ingest progress snapshot — surfaced inline on `AskResult.ingest` (a background top-up
 * observed alongside an answer). Shares the `IngestFailureDetail` base and the optional
 * `job_id` with `CollectionStatus.job` (`CollectionJob`) and `AskPending`, so all three
 * progress surfaces can be pinned to a specific job; the progress fields themselves differ by
 * surface (here `status` is a free string and the page counts are optional, whereas
 * `CollectionJob` narrows `state` to a union and requires the counts). */
export interface IngestProgress extends IngestFailureDetail {
  status: string;
  pages_done?: number;
  pages_total?: number;
  /** WHICH job this inline progress block describes — matches the `job_id` a caller's own
   * 202 named, so a background top-up observed on `AskResult.ingest` can be pinned to a
   * follow-up `status()` poll. Absent against a service too old to name jobs. */
  job_id?: string;
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
export interface AskPending extends IngestFailureDetail {
  collection: string;
  status: "ingesting";
  pages_done: number;
  pages_total: number;
  /** Seconds to wait before polling again. */
  retry_after: number;
  /**
   * WHICH ingest job this 202 is about, so a poller can name the job it is waiting for
   * instead of reading whichever job the collection happens to display. Match it against your
   * own `status().jobs[]` (see `CollectionJob.job_id`) rather than reading `status().job`,
   * which under concurrency can be a sibling.
   *
   * Presence: an `ingest` 202 always carries one (against a service new enough to send it).
   * An `ask` 202 carries the id of whichever job will answer it, WHEN the service can name
   * one — the job the ask created, a job it joined that an earlier identical ask started, or
   * (for a sources-less ask, or one whose own job is already terminal) the collection's
   * display job. So a present `job_id` does NOT by itself mean "this ask created the job":
   * always match it, never assume it is yours. Absent only against a service too old to name
   * jobs on an ask 202.
   */
  job_id?: string;
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

/**
 * Since worker PR #62, `POST /v1/rag/ingest`'s 200 also emits `pages_ok` and
 * `refunded_credits` unconditionally, and `failures` when non-empty — all three inherited
 * here from `IngestFailureDetail` rather than redeclared. They stay OPTIONAL on the type
 * even though the current service always sends `pages_ok`/`refunded_credits`: an older
 * deployment predates PR #62 and sends neither, and the client has to keep parsing its
 * response rather than assume a shape that only the newest server guarantees.
 * `pages_failed` is the one field narrowed to required — the service has sent it since
 * before this type existed, so there is no old-deployment case to tolerate.
 */
export interface IngestResult extends IngestFailureDetail {
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

/**
 * One ingest job's progress, as `status()` reports it — the shape `CollectionStatus.job`
 * has always had, extracted and named so `jobs[]` can reuse it field-for-field.
 */
export interface CollectionJob extends IngestFailureDetail {
  pages_done: number;
  pages_total: number;
  state: "running" | "complete" | "failed";
  /**
   * WHICH job this status row describes. Optional in two ways a caller must tolerate: an
   * older deployment predates per-job rows and sends it nowhere, and a row carried over from
   * before those rows existed genuinely has no id. (Whether a CALLER is handed an id on a 202
   * is a separate question about a different field — see `AskPending.job_id`.)
   *
   * Match it against the `job_id` from your own 202 rather than assuming `job` is yours:
   * a collection can have several ingests in flight at once, and `job` is whichever one
   * the service selects for display.
   */
  job_id?: string;
}

/** Returned by the identity-signed, free `status()` op. */
export interface CollectionStatus {
  collection: string;
  model: string;
  pages: number;
  chunks: number;
  created_at: string;
  expires_at: string;
  /**
   * The collection-wide DISPLAY job: the most recent running job, else the most recent
   * job of any state. Under concurrent ingests this is not necessarily the job any
   * particular caller started — see `jobs`.
   */
  job?: CollectionJob;
  /**
   * EVERY retained job row, most recent first; `job` is the selected element of this
   * list. Absent from an older deployment that keeps one job per collection, which is
   * why a poller looking for a specific job must fall back to `job` rather than wait for
   * an array that will never arrive.
   */
  jobs?: CollectionJob[];
  request_id?: string;
}
