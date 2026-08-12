import { AgentXError, parseErrorBody, SpendCapError } from "@agentx402-ai/core";

// RE-EXPORT core's base + spend-cap error — never re-declare them, or cross-package
// `instanceof` breaks (two distinct class objects in node_modules).
export { AgentXError, SpendCapError };

/**
 * The worker's `{ error, code, hint }` responses map to this single class.
 * Subclassing core's base is allowed; re-declaring the base is not.
 * Callers branch on `e.code` (never on the class) — see RagErrorCode.
 */
export class AgentRagError extends AgentXError {
  constructor(
    message: string,
    code: string,
    status?: number,
    readonly hint?: string,
  ) {
    super(message, code, status);
    this.name = "AgentRagError";
  }
}

/** The full set of `code` strings the worker + SDK emit (spec Error taxonomy). */
export type RagErrorCode =
  // platform-shared (worker can emit any of these)
  | "not_found"
  | "payment_required"
  | "payment_invalid"
  | "already_processed"
  | "auth_required"
  | "invalid_key"
  | "invalid_request"
  | "value_too_large"
  | "rate_limited"
  | "idempotency_conflict"
  | "insufficient_credits"
  | "invalid_account_key"
  | "account_not_found"
  | "account_not_provisioned"
  | "facilitator_unavailable"
  | "internal_error"
  | "not_implemented"
  // agentrag-specific
  | "collection_not_found"
  | "collection_expired"
  | "collection_full"
  | "model_mismatch"
  | "invalid_source"
  | "ingest_failed"
  // A collection may hold only so many ingest jobs in flight at once; an ingest that
  // would exceed that is refused rather than queued. Retry after one of the live jobs
  // reaches a terminal state (poll `status()`), or ingest into a different collection.
  | "too_many_active_jobs"
  // client-side, pre-request / pre-signature
  | "invalid_config"
  | "request_failed"
  | "network_error"
  | "aborted"
  | "payto_mismatch"
  | "spend_cap_exceeded"
  | "unpinned_network"
  | "unsupported_network"
  | "network_mismatch"
  | "asset_mismatch"
  | "domain_mismatch"
  | "invalid_challenge"
  // Thrown by core's atomicAmountString, reached through buildPaymentHeader and
  // challengePriceUsd — i.e. any malformed amount on the signing path.
  | "invalid_amount"
  | "ingest_timeout";

/**
 * Map a worker HTTP response to a typed error. Shared by every verb's failure path.
 * Preserves the worker's `code` (else "request_failed") and `hint`; message is
 * `AgentRag ${status}: ${detail}` where detail is the body's `error` or the fallback label.
 */
export async function ragErrorFromResponse(
  res: Response,
  fallback: string,
): Promise<AgentRagError> {
  const bodyText = await res.text();
  // Parsing (including the type-checks on an untrusted body) is shared via core; only the
  // error CLASS is this SDK's, because that identity is what callers `instanceof`.
  const { detail, code, hint } = parseErrorBody(bodyText, fallback);
  return new AgentRagError(`AgentRag ${res.status}: ${detail}`, code, res.status, hint);
}
