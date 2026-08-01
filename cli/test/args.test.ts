import { describe, expect, it } from "vitest";
import { parseFlags, UsageError } from "../src/args";

describe("parseFlags", () => {
  it("collects positionals and camelCases known flags", () => {
    const { flags, positionals } = parseFlags(["ask", "what is x?", "--top-k", "5"]);
    expect(positionals).toEqual(["ask", "what is x?"]);
    expect(flags.topK).toBe(5); // numeric flag parsed to a number, key camelCased
  });

  it("rejects an unknown flag (fail-closed) with a UsageError", () => {
    expect(() => parseFlags(["--max-spend-us", "5"])).toThrow(UsageError);
    expect(() => parseFlags(["--bogus"])).toThrow(/unknown flag --bogus/);
  });

  it("boolean flags take no value and become true", () => {
    const { flags } = parseFlags(["ingest", "--refresh"]);
    expect(flags.refresh).toBe(true);
  });

  it("--wait is a boolean flag", () => {
    const { flags } = parseFlags(["ask", "q", "--wait"]);
    expect(flags.wait).toBe(true);
  });

  it("a value-expecting flag missing its value throws", () => {
    expect(() => parseFlags(["--collection"])).toThrow(/flag --collection requires a value/);
    expect(() => parseFlags(["--collection", "--wait"])).toThrow(
      /flag --collection requires a value/,
    );
  });

  it("an empty value is treated as missing (not silently accepted)", () => {
    expect(() => parseFlags(["--collection", ""])).toThrow(/flag --collection requires a value/);
  });

  it("numeric flags fail closed on a non-number (a typo'd cap must not disable it)", () => {
    expect(() => parseFlags(["--max-pages", "abc"])).toThrow(/must be a non-negative number/);
    expect(() => parseFlags(["--max-spend-usd", "-1"])).toThrow(/must be a non-negative number/);
    expect(() => parseFlags(["--days", "abc"])).toThrow(/must be a non-negative number/);
    expect(() => parseFlags(["--top-k", "abc"])).toThrow(/must be a non-negative number/);
    expect(() => parseFlags(["--max-session-spend-usd", "abc"])).toThrow(
      /must be a non-negative number/,
    );
  });

  it("--sources is repeatable and accumulates into an array, in order", () => {
    const { flags } = parseFlags([
      "ask",
      "q",
      "--sources",
      "https://a.example",
      "--sources",
      "https://b.example",
    ]);
    expect(flags.sources).toEqual(["https://a.example", "https://b.example"]);
  });

  it("a single --sources still produces a one-element array (never a bare string)", () => {
    const { flags } = parseFlags(["ingest", "--sources", "https://a.example"]);
    expect(flags.sources).toEqual(["https://a.example"]);
  });

  // Deviation from the Scout template (deliberate, per the task brief): the inert
  // --json/--pretty/--reveal flags Scout declares but never reads must not exist here.
  it("does not know about Scout's inert --json/--pretty/--reveal flags", () => {
    expect(() => parseFlags(["--json"])).toThrow(/unknown flag --json/);
    expect(() => parseFlags(["--pretty"])).toThrow(/unknown flag --pretty/);
    expect(() => parseFlags(["--reveal"])).toThrow(/unknown flag --reveal/);
  });
});
