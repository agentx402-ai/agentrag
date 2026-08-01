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
 * Authorized ceiling (USD) for an `extend` call: `max(1, ceil(chunks / CHUNKS_PER_BLOCK))`
 * blocks, times `days / 30`, at the per-block extend price.
 *
 * `chunks` defaults to 0 (-> the 1-block minimum) when the caller doesn't yet know the
 * collection's real size — e.g. call `status()` first for an accurate ceiling on a large
 * collection. This default can never falsely reject an honest quote: the worker's own
 * pre-auth 402 challenge quotes that SAME 1-block basis regardless of the collection's
 * real size (a deliberate choice — revealing the real size to an unauthenticated caller
 * would make extend an existence/size oracle). It only under-authorizes a genuinely
 * multi-block extend, which fails safe (SpendCapError) rather than silently signing more
 * than the caller actually reviewed.
 */
export function extendAuthorizedCeilingUsd(days: number, chunks = 0): number {
  const blocks = Math.max(1, Math.ceil(chunks / CHUNKS_PER_BLOCK));
  const units30d = days / 30;
  return blocks * units30d * EXTEND_BLOCK_USD;
}
