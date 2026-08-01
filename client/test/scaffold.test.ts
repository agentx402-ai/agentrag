import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ASK_BASE_USD, DEFAULT_MODEL, VERSION } from "../src/index";

describe("scaffold", () => {
  it("VERSION matches package.json (version-lockstep source 3 of 6)", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(VERSION).toBe(pkg.version);
  });
  it("pins the ask base price and the default model", () => {
    expect(ASK_BASE_USD).toBe(0.008);
    expect(DEFAULT_MODEL).toBe("@cf/baai/bge-m3");
  });
});
