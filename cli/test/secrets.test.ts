// Review fix round 1 (Important #3): scrubSensitiveEnv/isSensitiveEnvName had ZERO direct
// coverage — deleting the scrubSensitiveEnv(deps.env) call in mcp.ts entirely left the full
// suite green (only the ORDERING relative to resolveWalletIdentity was pinned, not that the
// call happens at all). This file closes that: a truth table for the name matcher, and a
// process.env sentinel before/after for the scrub itself.
import { describe, expect, it } from "vitest";
import { isSensitiveEnvName, scrubSensitiveEnv } from "../src/secrets";

describe("isSensitiveEnvName", () => {
  it("matches the explicit list", () => {
    expect(isSensitiveEnvName("AGENTRAG_PRIVATE_KEY")).toBe(true);
    expect(isSensitiveEnvName("AGENTRAG_ACCOUNT_KEY")).toBe(true);
  });

  it("matches the AGENTRAG_*_(PRIVATE_KEY|PAYER_KEY|ENCRYPTION_KEY|MNEMONIC|SEED_PHRASE) defense-in-depth pattern", () => {
    for (const name of [
      "AGENTRAG_PAYER_KEY", // funded external-payer key shape, mirroring agentkv's own
      "AGENTRAG_FOO_PRIVATE_KEY",
      "AGENTRAG_X_PAYER_KEY",
      "AGENTRAG_ENCRYPTION_KEY",
      "AGENTRAG_MNEMONIC",
      "AGENTRAG_SEED_PHRASE",
    ]) {
      expect(isSensitiveEnvName(name)).toBe(true);
    }
  });

  it("the pattern is case-insensitive", () => {
    expect(isSensitiveEnvName("agentrag_private_key")).toBe(true);
    expect(isSensitiveEnvName("Agentrag_Payer_Key")).toBe(true);
  });

  it("does not match unrelated AGENTRAG_ vars this CLI actually reads", () => {
    for (const name of [
      "AGENTRAG_ENDPOINT",
      "AGENTRAG_NETWORK",
      "AGENTRAG_HOME",
      "AGENTRAG_MAX_SPEND_USD",
      "AGENTRAG_MAX_SESSION_SPEND_USD",
    ]) {
      expect(isSensitiveEnvName(name)).toBe(false);
    }
  });

  it("does not match a non-AGENTRAG_-prefixed var, even one that looks like key material", () => {
    // Scoped to the AGENTRAG_ prefix so a user's UNRELATED third-party secret is never touched —
    // the restraint the review's Minor findings called out as correct and worth keeping.
    expect(isSensitiveEnvName("SOME_PRIVATE_KEY")).toBe(false);
    expect(isSensitiveEnvName("PRIVATE_KEY")).toBe(false);
    expect(isSensitiveEnvName("OPENAI_API_KEY")).toBe(false);
  });
});

describe("scrubSensitiveEnv", () => {
  it("deletes explicit + pattern-matched keys from the given env object, leaves everything else", () => {
    const env: NodeJS.ProcessEnv = {
      AGENTRAG_PRIVATE_KEY: "0xsecret",
      AGENTRAG_ACCOUNT_KEY: "ak_secret",
      AGENTRAG_PAYER_KEY: "0xpayer",
      AGENTRAG_ENDPOINT: "https://example.com",
      AGENTRAG_HOME: "/home/x/.agentrag",
      UNRELATED_SECRET: "keep-me",
    };
    scrubSensitiveEnv(env);
    expect(env.AGENTRAG_PRIVATE_KEY).toBeUndefined();
    expect(env.AGENTRAG_ACCOUNT_KEY).toBeUndefined();
    expect(env.AGENTRAG_PAYER_KEY).toBeUndefined();
    expect(env.AGENTRAG_ENDPOINT).toBe("https://example.com");
    expect(env.AGENTRAG_HOME).toBe("/home/x/.agentrag");
    expect(env.UNRELATED_SECRET).toBe("keep-me");
  });

  it("is a no-op on an env with nothing sensitive", () => {
    const env: NodeJS.ProcessEnv = { AGENTRAG_ENDPOINT: "https://example.com" };
    scrubSensitiveEnv(env);
    expect(env).toEqual({ AGENTRAG_ENDPOINT: "https://example.com" });
  });

  // Ambient-vs-injected: production calls this as `scrubSensitiveEnv(deps.env)` (mcp.ts), and
  // `deps.env` IS `process.env` in a real run (cli.ts: `const env = deps.env ?? process.env`).
  // A test that only ever scrubs an INJECTED plain object never exercises the default-parameter
  // fallback (`env: NodeJS.ProcessEnv = process.env`) — the exact "injected dependency proves
  // nothing about the ambient one" family this phase's constraints call out. This one puts the
  // sentinel in the REAL process.env and calls with no argument.
  it("scrubs the REAL process.env by default when called with no argument", () => {
    const SENTINEL = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    const saved = process.env.AGENTRAG_PRIVATE_KEY;
    process.env.AGENTRAG_PRIVATE_KEY = SENTINEL;
    try {
      expect(process.env.AGENTRAG_PRIVATE_KEY).toBe(SENTINEL);
      scrubSensitiveEnv();
      expect(process.env.AGENTRAG_PRIVATE_KEY).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env.AGENTRAG_PRIVATE_KEY;
      else process.env.AGENTRAG_PRIVATE_KEY = saved;
    }
  });
});
