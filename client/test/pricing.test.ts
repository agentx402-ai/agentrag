import { describe, expect, it } from "vitest";
import { ASK_BASE_USD, EXTEND_BLOCK_USD, INGEST_PAGE_USD, MAX_DOCUMENTS } from "../src/index";
import {
  askAuthorizedCeilingUsd,
  ceilAskUnits,
  extendAuthorizedCeilingUsd,
  ingestAuthorizedCeilingUsd,
  worstCaseIngestPages,
} from "../src/pricing";

// Mirrors the worker's own composite-charge formula (spec §11.3), independently re-derived
// from the worker's real routes rather than copied — these numbers must agree even though
// the two implementations can never share code across the client/service repo boundary.

describe("ceilAskUnits", () => {
  it("mirrors the worker's ceil(askPrice / ingestPrice) ratio", () => {
    expect(ceilAskUnits()).toBe(2); // ceil(0.008 / 0.005) = ceil(1.6) = 2
  });
});

describe("worstCaseIngestPages", () => {
  it("no sources -> 0 (no ingest at all)", () => {
    expect(worstCaseIngestPages(undefined, 20)).toBe(0);
    expect(worstCaseIngestPages([], 20)).toBe(0);
  });

  it("a crawl root claims the full maxPages ceiling (true count is unknowable ahead of the BFS)", () => {
    expect(worstCaseIngestPages(["https://ex.com/**"], 20)).toBe(20);
    // A crawl root present ALONGSIDE exact urls still claims the full ceiling.
    expect(worstCaseIngestPages(["https://a.com", "https://ex.com/**"], 5)).toBe(5);
  });

  it("all-exact-url sources claim their own count, capped at maxPages", () => {
    expect(worstCaseIngestPages(["https://a.com", "https://b.com"], 20)).toBe(2);
    expect(worstCaseIngestPages(["https://a.com", "https://b.com", "https://c.com"], 2)).toBe(2);
  });
});

describe("askAuthorizedCeilingUsd", () => {
  it("no sources -> the flat ask price", () => {
    expect(askAuthorizedCeilingUsd(undefined, 20)).toBe(ASK_BASE_USD);
    expect(askAuthorizedCeilingUsd([], 20)).toBe(ASK_BASE_USD);
  });

  it("with sources -> the composite ingest-denominated ceiling", () => {
    // (1 exact url + ceilAskUnits()=2) * INGEST_PAGE_USD = 3 * 0.005 = 0.015
    expect(askAuthorizedCeilingUsd(["https://a.com"], 20)).toBeCloseTo(0.015, 9);
  });

  it("a crawl root prices off the full maxPages ceiling", () => {
    // (5 + 2) * 0.005 = 0.035
    expect(askAuthorizedCeilingUsd(["https://ex.com/**"], 5)).toBeCloseTo(0.035, 9);
  });
});

describe("ingestAuthorizedCeilingUsd", () => {
  it("sources only", () => {
    expect(ingestAuthorizedCeilingUsd(["https://a.com", "https://b.com"], 0, 20)).toBeCloseTo(
      2 * INGEST_PAGE_USD,
      9,
    );
  });

  it("documents only", () => {
    expect(ingestAuthorizedCeilingUsd(undefined, 3, 20)).toBeCloseTo(3 * INGEST_PAGE_USD, 9);
  });

  it("sources and documents combine", () => {
    expect(ingestAuthorizedCeilingUsd(["https://a.com"], 2, 20)).toBeCloseTo(
      3 * INGEST_PAGE_USD,
      9,
    );
  });

  it("documents clamps at MAX_DOCUMENTS, mirroring the worker's own preview clamp", () => {
    expect(ingestAuthorizedCeilingUsd(undefined, MAX_DOCUMENTS + 50, 20)).toBeCloseTo(
      MAX_DOCUMENTS * INGEST_PAGE_USD,
      9,
    );
  });
});

describe("extendAuthorizedCeilingUsd", () => {
  it("unknown chunk count defaults to the 1-block minimum (never falsely rejects the worker's own stateless pre-auth quote)", () => {
    expect(extendAuthorizedCeilingUsd(30)).toBeCloseTo(1 * EXTEND_BLOCK_USD, 9);
    expect(extendAuthorizedCeilingUsd(90)).toBeCloseTo(3 * EXTEND_BLOCK_USD, 9);
  });

  it("scales with the real chunk count: ceil(chunks / CHUNKS_PER_BLOCK) blocks", () => {
    // 12,000 chunks -> ceil(12000/5000) = 3 blocks; 60 days = 2 30-day units.
    expect(extendAuthorizedCeilingUsd(60, 12_000)).toBeCloseTo(3 * 2 * EXTEND_BLOCK_USD, 9);
  });
});
