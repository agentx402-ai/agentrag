import { describe, expect, it } from "vitest";
import { creditsRemaining, settledTxHash } from "../src/payment";

// AgentRAG's worker emits PAYMENT-RESPONSE and X-AgentKV-Credits-Remaining on a paid 200 —
// headers AgentScout's SDK never reads, so there is no Scout template for this pair of
// helpers. Pin their behavior directly.

function receiptHeader(body: unknown): string {
  return btoa(JSON.stringify(body));
}

describe("settledTxHash", () => {
  it("decodes the txHash from a well-formed PAYMENT-RESPONSE header", () => {
    const res = new Response("{}", {
      headers: {
        "PAYMENT-RESPONSE": receiptHeader({
          success: true,
          payer: "0xabc",
          amount: "8000",
          txHash: "0xdeadbeef",
        }),
      },
    });
    expect(settledTxHash(res)).toBe("0xdeadbeef");
  });

  it('returns "" (not undefined) for a credit-funded op — success but no on-chain settle', () => {
    const res = new Response("{}", {
      headers: {
        "PAYMENT-RESPONSE": receiptHeader({
          success: true,
          payer: "0xabc",
          amount: "0",
          txHash: "",
        }),
      },
    });
    expect(settledTxHash(res)).toBe("");
  });

  it('returns "" when the header is absent', () => {
    expect(settledTxHash(new Response("{}"))).toBe("");
  });

  it('returns "" on a malformed (non-base64/non-JSON) header rather than throwing', () => {
    const res = new Response("{}", {
      headers: { "PAYMENT-RESPONSE": "not-valid-base64!" },
    });
    expect(settledTxHash(res)).toBe("");
  });

  it('returns "" when the decoded body carries no string txHash', () => {
    const res = new Response("{}", {
      headers: { "PAYMENT-RESPONSE": receiptHeader({ success: true }) },
    });
    expect(settledTxHash(res)).toBe("");
  });
});

describe("creditsRemaining", () => {
  it("parses a numeric X-AgentKV-Credits-Remaining header", () => {
    const res = new Response("{}", {
      headers: { "X-AgentKV-Credits-Remaining": "42" },
    });
    expect(creditsRemaining(res)).toBe(42);
  });

  it("returns 0 as a real, distinct value (never coerced to undefined)", () => {
    const res = new Response("{}", {
      headers: { "X-AgentKV-Credits-Remaining": "0" },
    });
    expect(creditsRemaining(res)).toBe(0);
  });

  it("returns undefined when the header is absent", () => {
    expect(creditsRemaining(new Response("{}"))).toBeUndefined();
  });

  it("returns undefined on a non-numeric header value", () => {
    const res = new Response("{}", {
      headers: { "X-AgentKV-Credits-Remaining": "not-a-number" },
    });
    expect(creditsRemaining(res)).toBeUndefined();
  });
});
