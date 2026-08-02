import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type ResolvedConfig, resolveConfig } from "../src/config";

// The plugin's two manifests have to agree with each other, and nothing else checks that they do:
// CI validates they are well-formed JSON, never what is inside them. A sibling repo shipped a real
// bug through exactly this gap — its plugin.json collected the user's account key in a sensitive
// field while .mcp.json never passed it to the server, so the value was silently discarded.
// Both directions are failures, so both are pinned here:
//   declared but not passed  -> collected and thrown away
//   passed but not declared  -> always empty, because nothing ever populates it
const mcp = JSON.parse(
  readFileSync(new URL("../../plugin/agentrag/.mcp.json", import.meta.url), "utf8"),
) as {
  mcpServers: Record<string, { args: string[]; env: Record<string, string> }>;
};
const plugin = JSON.parse(
  readFileSync(
    new URL("../../plugin/agentrag/.claude-plugin/plugin.json", import.meta.url),
    "utf8",
  ),
) as { userConfig: Record<string, unknown> };

const env = mcp.mcpServers.agentrag.env;
/** The `user_config.<name>` keys the server is actually handed, e.g. "${user_config.account_key:-}". */
const passedThrough = new Set(
  Object.values(env)
    .map((v) => /\$\{user_config\.([A-Za-z0-9_]+)/.exec(v)?.[1])
    .filter((k): k is string => k !== undefined),
);
const declared = new Set(Object.keys(plugin.userConfig));

describe("plugin manifests agree", () => {
  it("every declared userConfig field is passed to the server (none collected then discarded)", () => {
    expect([...declared].filter((k) => !passedThrough.has(k))).toEqual([]);
  });

  it("every user_config reference resolves to a declared field (none silently always-empty)", () => {
    expect([...passedThrough].filter((k) => !declared.has(k))).toEqual([]);
  });

  // Named explicitly: it is the only way a managed-wallet user reaches account-key mode at all,
  // and losing it fails silently rather than loudly.
  it("the account key reaches the server", () => {
    expect(env.AGENTRAG_ACCOUNT_KEY).toContain("user_config.account_key");
    expect(plugin.userConfig.account_key).toMatchObject({ sensitive: true });
  });

  it("the wallet private key reaches the server and is marked sensitive", () => {
    expect(env.AGENTRAG_PRIVATE_KEY).toContain("user_config.private_key");
    expect(plugin.userConfig.private_key).toMatchObject({ sensitive: true });
  });

  // AgentRAG has no publisher tolls in v1 (Task 8 verified zero occurrences of "toll" in cli/) —
  // carrying the AgentScout template's max_toll_usd knob over would advertise a cap on a spend
  // category this service never charges.
  it("declares no toll field (AgentRAG has no publisher tolls)", () => {
    expect(declared.has("max_toll_usd")).toBe(false);
    expect(Object.keys(env)).not.toContain("AGENTRAG_MAX_TOLL_USD");
  });

  // Key material must arrive as environment, never on a command line, where argv is readable by
  // other processes and lands in shell history.
  it("no key material is passed as a command-line argument", () => {
    const { args } = mcp.mcpServers.agentrag;
    expect(args.some((a) => /user_config|key/i.test(a))).toBe(false);
  });

  // The runtime pin is version-lockstep source 6 (RELEASING.md) — without it the plugin spawns
  // whatever @agentrag/cli is latest at install time, so the lockstep binds a declared version
  // but not the one that actually runs.
  it("pins the MCP runtime to an exact version, never @latest", () => {
    const { args } = mcp.mcpServers.agentrag;
    const pinned = args.find((a) => a.startsWith("@agentrag/cli@"));
    expect(pinned).toBeDefined();
    expect(pinned).not.toContain("@latest");
    expect(pinned).toMatch(/^@agentrag\/cli@\d+\.\d+\.\d+/);
  });

  // Rule, not a name list: the two tests above pin "private_key"/"account_key" by name, so a
  // THIRD secret-shaped field (e.g. a future seed_phrase) would ship with no sensitive:true and
  // nothing here would catch it — displayed and stored in plaintext in the plugin config UI.
  it("every secret-shaped userConfig field is marked sensitive (name-pattern rule, not just the two known fields)", () => {
    const secretLike = /key|secret|seed|mnemonic|passphrase|token/i;
    const unmarked = Object.entries(plugin.userConfig)
      .filter(([name]) => secretLike.test(name))
      .filter(([, def]) => (def as { sensitive?: boolean }).sensitive !== true)
      .map(([name]) => name);
    expect(unmarked).toEqual([]);
  });
});

// The suite above only proves each "${user_config.X}" REFERENCE resolves to a declared
// userConfig field — it never checks the env var NAME on the left (e.g.
// "AGENTRAG_MAX_SESSION_SPEND_USD") against what `resolveConfig` actually reads. A rename on
// either side leaves every check above green: the manifest is still internally consistent, but
// the CLI reads `undefined` for that var and silently applies its documented default — no spend
// cap (warning on stderr only, which a plugin user never sees), a freshly minted unfunded
// wallet in place of the configured private key, or dropping out of account-key mode entirely.
describe("plugin env var NAMES match what resolveConfig actually reads", () => {
  // One sentinel per env var .mcp.json declares, plus the resolved-config field it MUST land in.
  // Values are fixed here, independent of config.ts, so this cannot pass by construction — it
  // only passes if resolveConfig genuinely reads that exact env var name into that exact field.
  const checks: Record<
    string,
    { raw: string; expected: unknown; read: (c: ResolvedConfig) => unknown }
  > = {
    AGENTRAG_ENDPOINT: {
      raw: "https://sentinel.example",
      expected: "https://sentinel.example",
      read: (c) => c.endpoint,
    },
    AGENTRAG_NETWORK: {
      raw: "eip155:999999",
      expected: "eip155:999999",
      read: (c) => c.network,
    },
    AGENTRAG_MAX_SPEND_USD: {
      raw: "1.25",
      expected: 1.25,
      read: (c) => c.maxSpendUsd,
    },
    AGENTRAG_MAX_SESSION_SPEND_USD: {
      raw: "9.75",
      expected: 9.75,
      read: (c) => c.maxSessionSpendUsd,
    },
    AGENTRAG_PRIVATE_KEY: {
      raw: "0xsentinelprivatekey",
      expected: "0xsentinelprivatekey",
      read: (c) => c.privateKey,
    },
    AGENTRAG_ACCOUNT_KEY: {
      raw: "sentinel-account-key",
      expected: "sentinel-account-key",
      read: (c) => c.accountKey,
    },
  };

  it("every env var .mcp.json declares has a check here, and vice versa", () => {
    // Bidirectional-by-NAME, mirroring the bidirectional-by-REFERENCE checks above: an env var
    // added to .mcp.json with no matching entry here would otherwise go untested, not merely
    // undetected — this fails loudly instead of silently skipping coverage.
    expect(Object.keys(checks).sort()).toEqual(Object.keys(env).sort());
  });

  it("each sentinel value survives the REAL resolveConfig into the field it claims to set", () => {
    const sentinelEnv: NodeJS.ProcessEnv = {};
    for (const [name, check] of Object.entries(checks)) sentinelEnv[name] = check.raw;
    // The exact function `prepareMcp` calls in production: resolveConfig({}, deps.env, ...).
    // No fake/injected config layer — this drives the ambient env-reading path for real.
    const resolved = resolveConfig({}, sentinelEnv, () => null);
    for (const [name, check] of Object.entries(checks)) {
      expect(check.read(resolved), `${name} did not reach its claimed config field`).toEqual(
        check.expected,
      );
    }
  });
});
