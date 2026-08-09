# Changelog

All notable changes to this project are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project adheres to [SemVer](https://semver.org/).

## [0.1.3] — 2026-08-09

### Added

- **`refunded_credits` on ingest progress.** Credits minted back for pages that were charged
  but never indexed, present on both terminal states.

  It is on the **failed** state that this matters. An ingest that dies after starting now
  refunds its unspent budget automatically, where previously the caller kept the entire charge
  until an operator intervened. A caller who paid should be able to see that they were made
  whole rather than infer it from a balance.

### Notes

- **Credits, not USDC.** A caller who paid in USDC is made whole in store credit, at the rate
  their charge actually settled through.
- **`0` and absent mean different things.** `0` is "nothing was owed back" — every charged page
  was indexed. Absent is an older service that cannot say. Do not collapse them; reporting
  "refunded nothing" when the truth is "unknown" is worse than reporting nothing.
- Requires the AgentRAG service deployed 2026-08-09 or later.

## [0.1.2] — 2026-08-08

### Added

- **Ingest progress now says why pages failed.** Every surface that reports ingest progress
  — `AskResult.ingest`, the `AskPending` returned by `ask()`/`ingest()`, and
  `CollectionStatus.job` — can now carry `pages_ok`, `pages_failed`,
  `failures[{ url, reason }]` and `stopped`.

  Previously an ingest could fail every page and report it in the vocabulary of success:
  `pages_done === pages_total`, `status: "complete"`, an empty collection, and nothing
  saying why. A toll-gated source is the realistic way to hit that — AgentRAG fetches
  through AgentScout with no toll budget, so a paywalled page fails closed as
  `upstream_status_402` rather than being paid for.

- **`RagPageFailure` and `IngestFailureDetail`** are exported. `IngestProgress` extends the
  latter, and `AskPending` and `CollectionStatus.job` mirror it field-for-field, so the
  three progress surfaces cannot drift apart.

### Notes

- Every new field is **optional**, and reading them defensively is required rather than
  polite: collections whose ingest job predates this release still return a progress block
  without them, and Durable Object rows have no migration path.
- `failures` is capped server-side at 20 entries across a whole job. **`pages_failed` is the
  authoritative count** — on a large wholesale failure the array is shorter than it, so
  never read `failures.length` as the number of failures.
- `reason` is a free-form, open set (`upstream_status_402`, `thin_content`, `no_chunks`,
  `fetch_failed:*`), deliberately not part of the `RagErrorCode` taxonomy: it describes one
  page's fate, not the request's outcome. Match with `startsWith`, never exhaustively.
- Requires the AgentRAG service deployed 2026-08-08 or later. Against an older service the
  fields are simply absent, which is exactly the pre-detail behavior above.

## [0.1.1] — 2026-08-08

### Changed

- **`client` now depends on `@agentx402-ai/core@^0.4.0`** (was `^0.3.0`). Core 0.4.0 added
  `breakdown` and `expiring_soon` to `UsageBlock`, mirroring fields the AgentRAG worker
  already emits — `expiring_soon` in particular is an AgentRAG concept: it is set on a
  response when a collection is inside the final 24h of its lifetime, the caller's cue to
  `extend()` before the collection is lost. A caret on a `0.x` version pins the minor, so
  `^0.3.0` could never resolve 0.4.0 — `@agentrag/client@0.1.0` saw neither field. This is
  types-only (the JSON already arrived on the wire either way), but without the type a
  caller could not reference `usage.expiring_soon` without widening it by hand.
- `cli`'s dependency on `@agentrag/client` bumped to `^0.1.1` to match.

## [0.1.0] — 2026-08-08

### Added

- Initial release: `@agentrag/client` (the SDK — x402 payments, spend caps,
  ask/ingest/extend/status), `@agentrag/cli` (`agentrag` CLI plus the `agentrag mcp` MCP
  server), and a Claude Code plugin wrapping the MCP server.
