import { describe, expect, it } from "vitest";
import { generateAccountKey, isAccountKeyFormat } from "../src/index";

describe("account-key helpers", () => {
  it("generates ak_ + 64 lowercase hex", () => {
    const k = generateAccountKey();
    expect(k).toMatch(/^ak_[0-9a-f]{64}$/);
    expect(isAccountKeyFormat(k)).toBe(true);
  });
  it("rejects non-conforming input", () => {
    expect(isAccountKeyFormat("ak_XYZ")).toBe(false);
    expect(isAccountKeyFormat(123)).toBe(false);
    expect(isAccountKeyFormat(`ak_${"a".repeat(63)}`)).toBe(false);
  });
});
