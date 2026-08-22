# Changelog

All notable changes to this project are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project adheres to [SemVer](https://semver.org/).

## [0.1.8] — 2026-08-22

### Changed

- Adopt `@agentx402-ai/core` `^0.4.1`, which brings `@x402/core` + `@x402/evm` 2.23.0 (the
  registry field rename `address` → `asset`, handled internally by core). No public API or
  behavior change here — the payment path is unaffected. Also refreshes `viem` to 2.55.19 and
  `@biomejs/biome` to 2.5.10.

## [0.1.7] — 2026-08-19

### Fixed

- **`askAndWait()` can no longer sign an unbounded number of payment authorizations.** The
  re-ask loop is now pinned to a single idempotency key (hence a single EIP-3009 nonce) for
  every re-ask iteration, even on the default no-`idempotencyKey` path — previously each
  re-ask minted a fresh, separately-settleable nonce, so a server that kept returning `202`
  could drive one call into many distinct signed authorizations. A server-supplied
  `retry_after` is also floored (`MIN_SERVER_POLL_INTERVAL_MS`) so it cannot dictate a
  zero-delay poll/re-ask loop; an explicit `pollIntervalMs` (including `0`) is unaffected.
- **Spend caps now bind account-key (bearer) mode.** `maxSpendUsd` / `maxSessionSpendUsd`
  were only enforced on the wallet path; the account-key path (prepaid credits — real money)
  returned before any check. It now asserts the per-call cap against the op's authorized
  ceiling before the request and records the cumulative spend from the response's usage.
- **`ingestAndWait()` / `askAndWait()` no longer fabricate a `"failed"` verdict** for a
  running, already-paid ingest whose retained job row has not caught up: `selectJob` now
  falls back to the display job when it names your own `job_id`, treats a `null`/empty wire
  `job_id` as "no id" (display-job fallback), and no longer adopts an unrelated sibling from a
  present-but-empty `jobs[]`.
- **CLI rejects dropped positionals and single-dash flag typos.** `agentrag ask what is x`
  (unquoted), `agentrag delete a b c`, and a stray `agentrag ingest mycollection` used to
  silently act on only the first token / a derived collection; a single-dash token that names
  a flag (`-collection`, `-max-spend-usd`) used to become a positional, defeating the
  fail-closed unknown-flag guard (a free-text query that merely begins with a dash still
  parses). All are now usage errors. `agentrag mcp` rejects trailing flags rather than
  silently dropping money-relevant ones (e.g. `--max-spend-usd`).
- **`totalPriceUsd` can no longer return `NaN`** from a malformed success body — a
  missing/non-numeric `price_usd` coerces to 0 instead of poisoning the account-mode spend
  ledger (which would refuse all further spend, since `NaN <= cap` is always false).
- **`ingestAndWait` no longer makes a redundant terminal `status()` round trip.** The poll now
  returns the parsed status alongside the pinned job, so the terminal iteration's own snapshot
  is reused for the result assembly — one fewer request, and the assembled `status`/counters
  can no longer disagree with what the poll observed (two separate reads previously could).
- **`config.json` fails closed on a `privateKey`/`accountKey` field** instead of silently
  ignoring it (secrets are env-only) — it was both inert and a plaintext key on disk.
- `ask()` now validates `collection` pre-request like every other collection verb;
  `maxRetries` rejects `Infinity`/`NaN` at construction; `extend()` accepts an
  `idempotencyKey` so a retried-but-settled extend dedups instead of double-charging.
- **`rag_ingest`'s MCP `destructiveHint` is now `true`** — `refresh:true` overwrites indexed
  content, a non-additive update, so a host should prompt before it.
- Documentation corrections: the "SDK never signs a self-computed sum" invariant is scoped to
  exclude `extend`'s deliberate self-computed (structurally-bounded) amount; SECURITY.md no
  longer describes secret-source read-refusal guards that do not exist in this repo; the
  `AskPending`/`CollectionJob` `job_id` presence rules match the deployed server; the plugin
  README reflects that `@agentrag/cli` is published and pinned at `0.1.6`.

### Added

- **`job_id` on `IngestProgress`** — the inline `AskResult.ingest` progress surface can now be
  pinned to a follow-up `status()` poll, matching `AskPending` and `CollectionJob`.
- **`extend(collection, days, { idempotencyKey })`** — optional idempotency key for safe retries.
- **`MIN_SERVER_POLL_INTERVAL_MS`** export — the floor applied to a server-supplied `retry_after`.

### Deprecated

- **`AgentRag`'s `protected pollIngestJobState`** — superseded by `protected pollIngestJob`,
  which returns the parsed `status` alongside the pinned job. The wait methods now route through
  `pollIngestJob`, so a subclass that overrode the older one-arg helper can no longer silently
  unpin them. `pollIngestJobState` remains as a thin delegate for backward compatibility.

## [0.1.6] — 2026-08-12

### Fixed

- **`askAndWait()` and `ingestAndWait()` now wait on YOUR job, not the collection's.** Both
  polled `status().job` — the collection-wide *display* job, which is whichever ingest the
  service picks to show, not necessarily the one your call started. A collection can run
  several ingests at once (one job per distinct spec), so with concurrent ingests against the
  same collection either method could:

  - **return early on a sibling's completion** — `askAndWait` answering against a collection
    its own ingest had not finished filling, and `ingestAndWait` reporting another job's
    `status`, `pages_ok`, `pages_failed`, `failures`, `stopped` and `refunded_credits` as
    yours, on the very fields you paid to learn; or
  - **wait forever** — if a sibling job outlived yours, the poll kept seeing `running` past
    your own job's completion, until `maxWaitMs` expired as a bogus timeout.

  Both now pin every read to the `job_id` their own `202` named. Serial callers were never
  affected; nothing about the single-ingest path changes.

  If you hand-rolled a poll loop, apply the same fix: match `job_id` from your `202` against
  `status().jobs[]` rather than reading `status().job`.

### Added

- **`job_id` on `AskPending`** — which ingest job a `202` is about. An `ingest` `202` always
  carries one; an `ask` `202` only when that ask *created* the job rather than joining one
  already running.
- **`jobs[]` on `CollectionStatus`** — every retained job row, most recent first. `job` is the
  selected element of that list. The row shape is now exported as **`CollectionJob`**, which
  `job` and `jobs[]` share field-for-field.
- **`too_many_active_jobs` error code.** A collection caps how many ingest jobs may be in
  flight at once; an ingest over that cap is refused rather than queued. The service emits it
  as of today; the type now declares it. Retry once a live job reaches a terminal state (poll
  `status()`), or ingest into a different collection.

### Notes

- All three additions are optional and backward-compatible in both directions. Against a
  service too old to name jobs, `job_id` and `jobs[]` are simply absent and both wait methods
  fall back to exactly their previous display-job behavior.

## [0.1.5] — 2026-08-09

### Added

- **`ingestAndWait()`** — resolves an async ingest and returns a normal `IngestResult`, the
  same way `askAndWait()` already did for `ask`. Also `--wait` on `agentrag ingest`, and a
  `wait` parameter on the `rag_ingest` MCP tool.

  `ask` had an await affordance on all three surfaces and `ingest` had none — on the verb
  that actually runs long. An `ask` is usually instant; its async path only fires when it has
  to ingest first. An `ingest` over a crawl root can take minutes, and every caller was left
  to hand-roll the poll loop from a `202`.

- **`IngestResult` now declares `pages_ok`, `failures`, `stopped` and `refunded_credits`**
  (via `IngestFailureDetail`). The service has sent them on the ingest `200` since the
  failure-reason release; the type simply had not caught up, so they were unreachable from
  TypeScript.

### Notes

- **`ingestAndWait` never re-issues the ingest.** Unlike `askAndWait` — which must re-ask,
  because its `202` carried no answer — the ingest is already finished when the job leaves
  `running`. Re-issuing it would be a second charge for work already paid for. The result is
  assembled from the `202` (which carries `usage`) plus one free `status()` read, and a test
  counts the ingest requests to keep it that way.
- Timeouts behave like `askAndWait`'s: `ingest_timeout` means patience ran out, not the
  ingest. The job keeps running server-side and stays readable through `status()`.

## [0.1.4] — 2026-08-09

Housekeeping. No wire changes, no behavior changes, no new fields.

### Changed

- **`RagUsageBlock` is now a plain alias for `UsageBlock`.** It began as a superset because
  `breakdown` and `expiring_soon` existed on core's main branch but not in any published
  core. Core 0.4.0 shipped both natively and this package's floor is already `^0.4.0`, so the
  superset had nothing left to add — verified field-for-field against the installed core,
  including that `expiring_soon` is the literal `true` type rather than `boolean`.

  Not a breaking change: the name never carried an `export`, so no consumer could import it;
  it reaches callers only structurally, through `AskResult["usage"]` and friends. AgentScout
  and AgentKV both re-export core's `UsageBlock` directly, and AgentRAG was the last client
  still carrying a local superset.

- **`RagPageFailure.reason` is documented more precisely.** It previously read "a free-form,
  OPEN set" while the service called the same thing "a closed vocabulary" — a contradiction
  in wording, though both gave the same advice. Neither was quite right: the *categories* are
  closed, but `upstream_status_<code>` and `fetch_failed:<detail>` carry variable suffixes, so
  the concrete strings are not. Hence `startsWith`, never an exhaustive `switch`.

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
