import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { AgentRag, AgentRagError } from "../src/index";

// Money-safety invariant: a malformed spend cap fails CLOSED (throws), it never silently
// becomes "unlimited". This guards the SDK boundary itself — a direct client consumer, or
// an unvalidated config.json path, can hand the constructor any value. Unlike AgentScout,
// AgentRAG has no per-op toll budget to validate here (v1 pays no publisher tolls) — only
// the two constructor-level caps.

const endpoint = "https://rag.example";
const signer = privateKeyToAccount(generatePrivateKey());

describe("spend-cap finiteness (fail closed)", () => {
  const BAD: Array<[string, unknown]> = [
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ['a string ("$0.05" config typo)', "$0.05"],
    ["a negative number", -0.01],
  ];
  for (const [label, value] of BAD) {
    it(`constructing with maxSpendUsd = ${label} throws AgentRagError(invalid_config)`, () => {
      expect(() => new AgentRag({ signer, endpoint, maxSpendUsd: value as number })).toThrow(
        AgentRagError,
      );
      expect(() => new AgentRag({ signer, endpoint, maxSpendUsd: value as number })).toThrow(
        /non-negative finite number/,
      );
    });
    it(`constructing with maxSessionSpendUsd = ${label} throws AgentRagError`, () => {
      expect(
        () =>
          new AgentRag({
            signer,
            endpoint,
            maxSessionSpendUsd: value as number,
          }),
      ).toThrow(/non-negative finite number/);
    });
  }

  it("valid finite caps (including 0 and undefined) still construct", () => {
    expect(() => new AgentRag({ signer, endpoint })).not.toThrow();
    expect(
      () =>
        new AgentRag({
          signer,
          endpoint,
          maxSpendUsd: 0,
          maxSessionSpendUsd: 1.5,
        }),
    ).not.toThrow();
  });
});
