import { describe, expect, it } from "vitest";
import type { AskResult } from "../src/types";
import { totalPriceUsd } from "../src/usage";

// Spec §11.1: top-level `price_usd` is the PRIMARY verb's price on the taken path only;
// `breakdown[]` itemizes additional legs (e.g. an ask that also ingested pages). The
// request's true cost is price_usd + the sum of every breakdown entry — reading price_usd
// alone silently drops the ingest leg. This was misread three separate times while writing
// a live test harness against the deployed service, which is the evidence callers will too.
//
// Typed via AskResult["usage"] (not core's own UsageBlock, and not RagUsageBlock by name —
// that interface is deliberately module-private to types.ts, per I3): the installed
// @agentx402-ai/core@0.3.0 predates `breakdown`/`expiring_soon` landing on core's main, so
// only this SDK's own (private) superset type declares them today — see its doc comment.

type Usage = NonNullable<AskResult["usage"]>;

function usage(overrides: Partial<Usage> = {}): Usage {
  return {
    service: "rag",
    op: "ask",
    price_usd: 0.008,
    list_price_usd: 0.008,
    credits_charged: 0,
    ...overrides,
  };
}

describe("totalPriceUsd", () => {
  it("undefined usage totals to 0", () => {
    expect(totalPriceUsd(undefined)).toBe(0);
  });

  it("no breakdown -> just the top-level price_usd", () => {
    expect(totalPriceUsd(usage({ price_usd: 0.008 }))).toBe(0.008);
  });

  it("an absent breakdown sums the same as an explicitly empty one", () => {
    expect(totalPriceUsd(usage({ price_usd: 0.008, breakdown: undefined }))).toBe(0.008);
    expect(totalPriceUsd(usage({ price_usd: 0.008, breakdown: [] }))).toBe(0.008);
  });

  it("with an ingest leg -> top-level + the sum of the breakdown", () => {
    const u = usage({
      price_usd: 0.008,
      breakdown: [{ op: "ingest", units: 3, price_usd: 0.015 }],
    });
    expect(totalPriceUsd(u)).toBeCloseTo(0.023, 9);
  });

  it("sums MULTIPLE breakdown legs, not just the first", () => {
    const u = usage({
      price_usd: 0,
      breakdown: [
        { op: "ingest", units: 3, price_usd: 0.015 },
        { op: "ingest", units: 1, price_usd: 0.005 },
      ],
    });
    expect(totalPriceUsd(u)).toBeCloseTo(0.02, 9);
  });

  it("a missed (price_usd: 0) primary leg still counts a settled ingest leg — the exact misread this helper prevents", () => {
    const u = usage({
      price_usd: 0,
      breakdown: [{ op: "ingest", units: 3, price_usd: 0.015 }],
    });
    expect(totalPriceUsd(u)).toBeCloseTo(0.015, 9);
  });
});
