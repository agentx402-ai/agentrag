import type { RagModelId } from "./types";

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

// Pinned prices (USD) — parity-guarded against the worker (see the service's
// check-client-parity.mjs). The wire price always comes from the server's 402 challenge;
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
