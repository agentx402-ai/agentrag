import { describe, expect, it } from "vitest";
import {
  ASK_FLAGS,
  DELETE_FLAGS,
  EXTEND_FLAGS,
  extraPositionalError,
  GLOBAL_FLAGS,
  INGEST_FLAGS,
  parseFlags,
  STATUS_FLAGS,
  UsageError,
  WALLET_FLAGS,
} from "../src/args";

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

  it("rejects a SINGLE-dash flag typo instead of silently making it a positional", () => {
    // `-max-spend-usd 5` (one dash) must NOT slip through as two positionals — that would
    // leave the spend cap unset on real funds while looking like it was set.
    expect(() => parseFlags(["-max-spend-usd", "5"])).toThrow(UsageError);
    expect(() => parseFlags(["-collection"])).toThrow(/flags use two dashes/);
    // A lone "-" and non-flag positionals are still fine.
    expect(parseFlags(["ask", "what is x"]).positionals).toEqual(["ask", "what is x"]);
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

  // Review Important: "no test asserts a secret cannot be supplied as a flag." The config half
  // (secrets never read from config.json) was already guarded; this pins the flag half. Fails
  // today because neither name is in KNOWN_FLAGS — would catch a well-meaning "convenience
  // flag" PR that wired one in, exactly as the review demonstrated by adding one and watching
  // all 105 tests stay green.
  it("rejects --private-key and --account-key as flags (secrets are env-only, never a CLI flag)", () => {
    expect(() => parseFlags(["--private-key", "0xabc"])).toThrow(/unknown flag --private-key/);
    expect(() => parseFlags(["--account-key", "ak_abc"])).toThrow(/unknown flag --account-key/);
  });
});

describe("parseFlags with a per-command allowlist (the `allowed` param)", () => {
  it("rejects a globally-known flag that isn't in the allowed set", () => {
    // "days" is a real, KNOWN_FLAGS-listed flag (extend's) — this proves the allowlist rejects
    // it for a command that didn't ask for it, not merely typos outside KNOWN_FLAGS entirely.
    expect(() => parseFlags(["--days", "30"], new Set(["sources"]))).toThrow(
      /flag --days is not valid for this command/,
    );
  });

  it("still accepts a flag that IS in the allowed set", () => {
    const { flags } = parseFlags(["--days", "30"], new Set(["days"]));
    expect(flags.days).toBe(30);
  });

  it("with no allowed set given (cli.ts's own top-level parse), falls back to the full KNOWN_FLAGS", () => {
    const { flags } = parseFlags(["--days", "30"]); // no second argument at all
    expect(flags.days).toBe(30);
  });
});

// Review Minor: "every command accepts every other command's flags and silently drops them"
// (e.g. `agentrag ask q --refresh` used to parse clean and do nothing — a billing-relevant
// surprise, since AskOptions has no refresh wiring in ask.ts). These pin the exported
// allowlists themselves; commands-*.test.ts pins the resulting command-level BEHAVIOR.
describe("per-command flag allowlists", () => {
  it("GLOBAL_FLAGS is exactly the four config flags", () => {
    expect([...GLOBAL_FLAGS].sort()).toEqual(
      ["endpoint", "max-session-spend-usd", "max-spend-usd", "network"].sort(),
    );
  });

  it("ASK_FLAGS: the ask surface plus GLOBAL_FLAGS, and nothing extend/ingest-only", () => {
    for (const f of ["sources", "collection", "top-k", "mode", "max-pages", "wait", "endpoint"]) {
      expect(ASK_FLAGS.has(f)).toBe(true);
    }
    expect(ASK_FLAGS.has("refresh")).toBe(false); // ingest-only
    expect(ASK_FLAGS.has("documents")).toBe(false); // ingest-only
    expect(ASK_FLAGS.has("model")).toBe(false); // ingest-only
    expect(ASK_FLAGS.has("days")).toBe(false); // extend-only
  });

  it("INGEST_FLAGS: the ingest surface plus GLOBAL_FLAGS, and nothing ask/extend-only", () => {
    for (const f of [
      "sources",
      "documents",
      "collection",
      "model",
      "max-pages",
      "refresh",
      "wait",
    ]) {
      expect(INGEST_FLAGS.has(f)).toBe(true);
    }
    expect(INGEST_FLAGS.has("top-k")).toBe(false); // ask-only
    expect(INGEST_FLAGS.has("mode")).toBe(false); // ask-only
    expect(INGEST_FLAGS.has("days")).toBe(false); // extend-only
  });

  it("EXTEND_FLAGS: only --days plus GLOBAL_FLAGS", () => {
    expect(EXTEND_FLAGS.has("days")).toBe(true);
    for (const f of ["sources", "collection", "documents", "model", "wait", "refresh"]) {
      expect(EXTEND_FLAGS.has(f)).toBe(false);
    }
  });

  it("STATUS_FLAGS and DELETE_FLAGS accept only the global config flags, no verb-specific ones", () => {
    for (const flags of [STATUS_FLAGS, DELETE_FLAGS]) {
      expect([...flags].sort()).toEqual([...GLOBAL_FLAGS].sort());
    }
  });

  it("WALLET_FLAGS accepts nothing, not even the global config flags (wallet never calls resolveConfig)", () => {
    expect(WALLET_FLAGS.size).toBe(0);
  });
});

describe("extraPositionalError", () => {
  it("returns undefined for zero or one positional", () => {
    expect(extraPositionalError([], "ask", "query")).toBeUndefined();
    expect(extraPositionalError(["what is x"], "ask", "query")).toBeUndefined();
  });

  it("returns a usage message naming the count when there is more than one positional", () => {
    // The classic trap: an unquoted multi-word query arrives as multiple positionals.
    const msg = extraPositionalError(["what", "is", "x"], "ask", "query");
    expect(msg).toMatch(/ask takes a single <query>/);
    expect(msg).toMatch(/got 3/);
    expect(msg).toMatch(/quote it/);
  });
});
