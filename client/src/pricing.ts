// client/src/pricing.ts
//
// Client-side mirror of the worker's composite-charge formula (spec §11.3): an x402-paid
// `ask` that also needs an on-demand ingest is quoted — and settled — as ONE exact-match,
// ingest-denominated charge: (worst-case ingest pages + the ask price expressed in
// ingest-price units) × the ingest price, never the ask price plus a separately-signed
// ingest amount. These functions compute the AUTHORIZED CEILING a caller is willing to
// sign for a given request shape, from THIS SDK's own pinned prices — so a lying,
// spoofed, or simply-inflated server-side quote is refused before signing (the
// authorized-ceiling guard in `AgentRag#performOp`).
//
// CIRCULAR IMPORT, BY DESIGN: these formulas read ASK_BASE_USD / INGEST_PAGE_USD /
// EXTEND_BLOCK_USD / CHUNKS_PER_BLOCK / MAX_DOCUMENTS from "./index" (the single source
// of truth for pinned prices/limits), while index.ts's ask()/ingest()/extend() call these
// functions to compute the ceiling they hand to performOp — so the two modules import
// from each other. That is only safe because every import below is read INSIDE a
// function body, never at this module's own top level (no top-level `const X =
// ASK_BASE_USD / INGEST_PAGE_USD`): by the time any function here is actually CALLED,
// both modules have finished their own top-level evaluation and every binding is live.
// Do not hoist a value computed from these imports to module scope — that risks reading
// them before index.ts's own top-level code (which defines them) has run.
import {
  ASK_BASE_USD,
  CHUNKS_PER_BLOCK,
  EXTEND_BLOCK_USD,
  INGEST_PAGE_USD,
  MAX_CHUNKS,
  MAX_DOCUMENTS,
} from "./index";

/**
 * USD (a decimal float) to atomic USDC units (an integer; USDC has 6 decimals) — matching
 * how the worker's own price registry represents amounts, and how `PRICE_EPS` elsewhere
 * in this SDK is already documented as "one atomic unit". `Math.round`, not `Math.floor`
 * or a bare multiply: a pinned USD constant like 0.008 is not exactly representable in
 * binary floating point, so `0.008 * 1_000_000` can itself land a hair off 8000 — rounding
 * is what actually recovers the intended integer.
 */
export function usdToAtomic(usd: number): number {
  return Math.round(usd * 1_000_000);
}

/**
 * The ask price, expressed as a whole number of ingest-price units, rounded UP so a
 * composite quote never falls short of the ask's real cost. Mirrors the worker's
 * `Math.ceil(askPrice.atomic / ingestPrice.atomic)` — computed here from this SDK's
 * pinned USD prices, converted to atomic integers FIRST via `usdToAtomic`, matching the
 * worker's own integer division rather than dividing the USD floats directly.
 *
 * M3: a plain `Math.ceil(ASK_BASE_USD / INGEST_PAGE_USD)` is not equivalent to the
 * worker's atomic-integer division in general — verified for every (ask, ingest) atomic
 * pair in 1..3000, the float form is never LOWER (so it can never falsely reject an
 * honest quote) but can be exactly one unit HIGHER whenever the true ratio lands on a
 * whole number (e.g. atomic 33000/11000 -> worker/atomic 3, plain float form 4 — see
 * pricing.test.ts, which pins this exact pair). Today's real prices give 2 either way
 * (0.008/0.005 = 1.6 -> ceil 2), but a future price change landing on a whole ratio would
 * let this authorize one ingest unit ($0.005) more than the worker could ever quote.
 */
export function ceilAskUnits(): number {
  return Math.ceil(usdToAtomic(ASK_BASE_USD) / usdToAtomic(INGEST_PAGE_USD));
}

/**
 * The WORST-CASE ingest page count a given (sources, maxPages) pair could need. A
 * trailing-`/**` crawl root's true page count is unknowable ahead of the server's async
 * BFS, so it always claims the full maxPages ceiling — even alongside other exact-url
 * entries; an all-exact-url source list claims its own (maxPages-capped) count. No
 * sources at all -> 0 (no ingest, hence no ingest-priced work).
 */
export function worstCaseIngestPages(sources: string[] | undefined, maxPages: number): number {
  if (sources === undefined || sources.length === 0) return 0;
  const hasCrawlRoot = sources.some((s) => s.endsWith("/**"));
  if (hasCrawlRoot) return maxPages;
  return Math.min(sources.length, maxPages);
}

/**
 * Authorized ceiling (USD) for an `ask` call. No sources -> the flat ask price. With
 * sources, the worker prices — and settles — the composite as ONE ingest-denominated
 * charge: (worst-case pages + ceilAskUnits()) ingest-price units.
 */
export function askAuthorizedCeilingUsd(sources: string[] | undefined, maxPages: number): number {
  if (sources === undefined || sources.length === 0) return ASK_BASE_USD;
  return (worstCaseIngestPages(sources, maxPages) + ceilAskUnits()) * INGEST_PAGE_USD;
}

/**
 * Authorized ceiling (USD) for an `ingest` call: worst-case source pages plus the
 * document count, at the per-unit ingest price. A document's unit cost carries no
 * worst-case ambiguity (unlike a fetched page's presence/absence, it is fully known from
 * the request body alone), so it is added as-is. `documents` is a COUNT, clamped to
 * MAX_DOCUMENTS — mirroring the worker's own clamp on its pre-auth preview.
 */
export function ingestAuthorizedCeilingUsd(
  sources: string[] | undefined,
  documents: number,
  maxPages: number,
): number {
  const sourceUnits = worstCaseIngestPages(sources, maxPages);
  const documentUnits = Math.min(Math.max(documents, 0), MAX_DOCUMENTS);
  return (sourceUnits + documentUnits) * INGEST_PAGE_USD;
}

/**
 * The EXACT price (USD) of an `extend` call: `max(1, ceil(chunks / CHUNKS_PER_BLOCK))`
 * blocks, times `days / 30`, at the per-block extend price — the SAME formula the worker
 * settles on, given the collection's real chunk count.
 *
 * The worker's own pre-auth 402 challenge for extend is DELIBERATELY STATELESS — it always
 * quotes the 1-block-per-30-days basis (`days / 30` units) regardless of the named
 * collection's real chunk count, because reading the real count pre-auth would make extend
 * an existence/size oracle for an unauthenticated caller. `chunks` defaulting to 0 here
 * (-> the 1-block minimum) MATCHES that stateless quote — but the quote and the settled
 * charge are different things whenever the collection needs more than one block, and a
 * PRIOR version of this comment conflated them (claiming the default "can neither under-
 * nor over-authorize... on a collection of any real size", which is false for anything over
 * one block).
 *
 * A signed wallet-mode authorization does NOT have to equal the challenge's quoted amount:
 * extend is a genuine top-up-style route (the worker's own auth call for it passes
 * `allowTopUp`), so `buildPaymentHeader`'s `amountAtomic` override lets the client sign the
 * REAL price this function computes instead — `extend()` (index.ts) calls `status()` first
 * to learn the real chunk count, computes this function's result from it, and pins THAT as
 * the signed amount (`performOp`'s `pinnedAmountUsd`) regardless of what the stateless
 * challenge quoted. An EARLIER version of this fix (since withdrawn) assumed a wallet-mode
 * signature could never exceed the challenge's own amount and refused any multi-block
 * extend outright — that assumption was wrong: core's `selectRequirement` treats the
 * challenge as a network/asset/payTo TEMPLATE whenever an amount override is supplied, not
 * a pinned ceiling, and the worker's own test suite settles a real multi-block x402 payment
 * this way. A signed amount that's actually wrong (too low) is rejected by the worker's own
 * settle check, never silently adjusted — this function must compute the REAL price, not a
 * safe underestimate of it.
 *
 * `chunks` was originally test-only from the public API's perspective; `extend()` now passes
 * the real value it learns from `status()` in wallet mode (account-key mode never reads this
 * value at all — `performOp`'s bearer branch settles directly, with no signature to pin, so
 * it skips both this computation's real-chunks input and the `status()` call).
 *
 * DO NOT pass this function's own result as `performOp`'s `authorizedCeilingUsd` when
 * `chunks` came from `status()` (a SERVER-supplied value) — that was round 2's bug (since
 * fixed): the ceiling and the pinned amount became the identical expression, so the
 * "ceiling" check degenerated to `x <= x`, always true, and a server returning an
 * arbitrary/inflated chunk count got an unbounded signature. The ceiling passed to
 * `performOp` MUST be `maxExtendAmountUsd(days)` below — a bound derived from the
 * service's own STRUCTURAL cap, independent of any single server response — while this
 * function's result (from the real, server-supplied chunk count) is what's actually
 * pinned as the signed amount. See extend()'s own doc comment for the full reasoning.
 */
export function extendAuthorizedCeilingUsd(days: number, chunks = 0): number {
  const blocks = Math.max(1, Math.ceil(chunks / CHUNKS_PER_BLOCK));
  const units30d = days / 30;
  return blocks * units30d * EXTEND_BLOCK_USD;
}

/**
 * The ABSOLUTE MAXIMUM legitimate price (USD) for an `extend` call at `days`, for a
 * collection of ANY size — derived from the service's own structural cap on collection
 * size (`MAX_CHUNKS`), NOT from any server-supplied chunk count. This is what `extend()`
 * passes to `performOp` as `authorizedCeilingUsd`; `extendAuthorizedCeilingUsd(days,
 * realChunks)` (the server-supplied value) is what gets PINNED as the signed amount. The
 * two must come from independent sources — see `extendAuthorizedCeilingUsd`'s own doc
 * comment for the bug this closes. `MAX_CHUNKS` is a genuine hard limit (ingest itself
 * refuses past it with `collection_full`), so no LEGITIMATE extend can ever exceed this
 * ceiling — it is exact at the true boundary (a real 25,000-chunk, 90-day collection costs
 * exactly this), never merely a safe overestimate that would falsely reject a large but
 * real collection.
 */
export function maxExtendAmountUsd(days: number): number {
  return extendAuthorizedCeilingUsd(days, MAX_CHUNKS);
}
