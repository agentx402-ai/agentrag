// client/src/usage.ts
//
// Spec §11.1 (Phase W amendment): a paid op's usage envelope has TWO legs. The top-level
// `usage.price_usd` is the PRIMARY VERB's price on the taken path only; `usage.breakdown[]`
// itemizes additional legs the SAME request also settled (e.g. an `ask` that triggered an
// on-demand ingest). `totalPriceUsd` below is `price_usd` plus the sum of every breakdown
// entry's `price_usd` — reading `price_usd` alone silently drops the ingest leg.
//
// This is easy to misread: a pay-on-success ask that misses reports `price_usd: 0` even
// when its ingest leg genuinely settled (honest per-leg accounting, not a free ride), so a
// caller who reads only the top level sees "$0" for a request that really cost money.
//
// GROSS OF REFUND — a prior version of this comment called the sum the request's "TRUE
// total cost", which overstates it. A breakdown ingest leg is quoted and settled on the
// WORST-CASE page count the request authorized (spec §11.3), not the pages actually
// ingested; the unused remainder comes back separately as CREDITS (see the result's
// `creditsRemaining`), never netted into `breakdown[]` itself. `totalPriceUsd` is what the
// request SETTLED upfront — the amount actually charged, real money either as USDC or
// credits — not the caller's final net spend after any refund.
import type { AskResult } from "./types";

/**
 * What the request SETTLED, in USD: the primary verb's `price_usd` plus every
 * `breakdown[]` leg's `price_usd` (spec §11.1) — see this module's own header comment for
 * why that is gross-of-refund, not a final net cost. `undefined` usage (e.g. a free op)
 * totals to 0. An absent `breakdown` sums to 0, same as an explicitly empty one — both mean
 * "no additional legs".
 *
 * Typed as `AskResult["usage"]` rather than naming `RagUsageBlock` directly: that
 * interface is deliberately module-private to types.ts (I3 — it must never be
 * independently importable, so it never acquires a semver obligation of its own), but its
 * shape is exactly what every paid result's `usage` field carries. Indexing through an
 * already-public field type gets the real shape (including `breakdown`) without needing
 * the private name — any of `AskResult`/`AskPending`/`IngestResult`/`ExtendResult` would
 * give the identical type here, since all four share one declaration.
 */
export function totalPriceUsd(usage: AskResult["usage"]): number {
  if (usage === undefined) return 0;
  const breakdownTotal = (usage.breakdown ?? []).reduce((sum, leg) => sum + leg.price_usd, 0);
  return usage.price_usd + breakdownTotal;
}
