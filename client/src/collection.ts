// client/src/collection.ts
//
// Task 6: shared primitives for the free, identity-signed collection routes
// (`GET`/`DELETE /v1/rag/collection/:id`) — the FIRST identity-signed ops in this SDK
// (ask/ingest/extend are all paid, x402-or-bearer). `status()` and `delete()` (both on
// `AgentRag`, in index.ts) each name a collection and hit the same owner-gated resource, so
// the name validation and path construction live here once rather than twice — mirroring
// this module's own small-focused-file precedent (account.ts holds account-key primitives;
// this file holds collection-identity primitives).
import { AgentRagError } from "./errors";

/**
 * Mirrors the worker's own "collection is required and must be a non-empty string" check
 * (parseExtendBody / parseIngestBody's `collection` field) — rejected client-side, before
 * any request, the same discipline every other pre-request validator in this SDK follows.
 * An `asserts` signature (rather than returning a boolean) lets every call site read as a
 * plain guard clause, matching this file's callers' style.
 */
export function assertValidCollectionName(name: unknown): asserts name is string {
  if (typeof name !== "string" || name.length === 0) {
    throw new AgentRagError(
      "collection is required and must be a non-empty string",
      "invalid_request",
      0,
    );
  }
}

/**
 * The owner-gated single-collection resource path, shared by `status()` and `delete()` (and,
 * through `status()`, `askAndWait`'s internal poll). `encodeURIComponent` so a collection id
 * carrying a reserved URL character (e.g. `/` or `?`) cannot smuggle an extra path segment
 * or query string into the request.
 */
export function collectionPath(collection: string): string {
  return `/v1/rag/collection/${encodeURIComponent(collection)}`;
}
