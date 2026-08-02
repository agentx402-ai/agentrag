import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

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
});
