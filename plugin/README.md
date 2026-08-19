# AgentRAG Claude plugin

A [Claude Code](https://docs.claude.com/en/docs/claude-code) plugin that gives agents
x402-paid retrieval over their own documents — exposed as six MCP tools: `rag_ask` (ask a
grounded question, ingesting on demand), `rag_ingest` (explicitly index sources or raw
documents), `rag_extend` (push a collection's expiry out), the free `rag_status` (read a
collection's metadata and ingest state), the free `rag_delete` (purge a collection), and the
free `rag_wallet_address` (find the address to fund). Every paid call settles in USDC via x402
— wallet-native by default, with an opt-in account-key (`ak_` bearer) mode for managed wallets.
Collection content is **not** encrypted (it is stored and indexed in the clear server-side).

> **Prerequisite:** the plugin runs `npx -y @agentrag/cli@<version> mcp`, so
> [`@agentrag/cli`](../cli) must be resolvable via `npx`. It **is published to npm**, so `npx`
> fetches the pinned version automatically on first use and no local checkout is required (the
> local-checkout method below is for development only).
>
> **Windows:** `.mcp.json` uses `"command": "npx"`. Claude Code's MCP launcher resolves the
> `npx.cmd` shim on Windows automatically, so this works as-is. Other MCP clients that spawn the
> command naively (`child_process.spawn("npx", …)` without `shell: true`) throw `ENOENT` on
> Windows, since only `npx.cmd` exists on `PATH`. If you wire this server into such a client,
> set the command to `npx.cmd` (or `cmd /c npx`) there.

## Install

`@agentrag/cli` is published to npm; if this plugin is not yet registered in the shared
marketplace, use the **local checkout** method below until it is.

**1. Add the marketplace and install the plugin** — run these in Claude Code:

```text
/plugin marketplace add agentx402-ai/claude-plugins
/plugin install agentrag@agentx402
```

<details>
<summary>From a local checkout (for development)</summary>

```bash
git clone https://github.com/agentx402-ai/agentrag
cd agentrag && npm ci && npm run build
```

`--plugin-dir` loads `plugin/agentrag/.mcp.json` as checked in, and that file runs
`npx -y @agentrag/cli@<pinned> mcp` — a version-pinned registry spec (the exact version lives in
`.mcp.json`, kept in lockstep by the release process) that fetches the published package rather
than the local build you just made. To test a LOCAL build instead, point your **local,
uncommitted** copy of `.mcp.json` at it — edit `command`/`args` only, leave `env` as-is:

```json
{
  "mcpServers": {
    "agentrag": {
      "command": "node",
      "args": ["/absolute/path/to/agentrag/cli/dist/cli.js", "mcp"],
      "env": {
        "AGENTRAG_ENDPOINT": "${user_config.endpoint:-}",
        "AGENTRAG_PRIVATE_KEY": "${user_config.private_key:-}",
        "AGENTRAG_ACCOUNT_KEY": "${user_config.account_key:-}",
        "AGENTRAG_NETWORK": "${user_config.network:-eip155:8453}",
        "AGENTRAG_MAX_SPEND_USD": "${user_config.max_spend_usd:-}",
        "AGENTRAG_MAX_SESSION_SPEND_USD": "${user_config.max_session_spend_usd:-}"
      }
    }
  }
}
```

Then:

```bash
claude --plugin-dir ./plugin/agentrag
```

</details>

**2. Enter credentials when prompted.** On install, Claude Code asks for the plugin's config and
threads it into the MCP server for you — **no shell environment variables to set**:

| Prompt | Required | Notes |
|--------|----------|-------|
| Wallet private key | No | Optional — leave blank and AgentRAG mints + manages a local wallet on first use. To bring your own: an EVM hex key, masked + stored in your OS keychain |
| Account key | No | An `ak_…` bearer token for managed-wallet (credit) mode; funded out-of-band via AgentKV. If a wallet private key is also set, the account key silently wins and the wallet key is ignored |
| AgentRAG endpoint | No | Defaults to `https://api.agentx402.ai` (the hosted service) |
| Network | No | `eip155:8453` (Base mainnet, default) or `eip155:84532` (Base Sepolia testnet) |
| Max per-operation spend (USD) | No | refuses any single call costing more than this; leave empty for no per-op cap |
| Max session spend (USD) | No | refuses further calls once cumulative spend across the whole MCP session exceeds this; leave empty for no session cap |

Don't have a wallet? Leave "Wallet private key" blank — AgentRAG mints and manages a local
wallet on first use — then fund the address it prints (step 4).
To change any of these later, run `/plugin` and reconfigure the `agentrag` plugin.

**3. Verify it loaded:**

```text
/mcp
```

You should see the `agentrag` server **connected** with its six tools.

**4. Fund the payer.** In **wallet mode**, send USDC to your wallet address on Base — asks,
ingests, and extends are then paid inline per call via x402. In **account-key mode**, AgentRAG
has no deposit route of its own: fund the `ak_` account out-of-band via AgentKV by depositing to
`https://api.agentx402.ai/v1/account/deposit` under your bearer, and AgentRAG debits those
shared credits.

> **Managed wallets / account-key mode.** For a managed wallet that can't sign, AgentRAG
> supports an opt-in **account-key** mode (an `ak_…` bearer token identifies the account, funded
> by any signing wallet through AgentKV). AgentRAG pays no publisher tolls in either mode — there
> is no toll cap to configure. See the skill's **Account-key mode & funding** section for setup.

See the [skill](./agentrag/skills/agentrag/SKILL.md) for the full tool reference, pricing,
spend-cap guidance, account-key/managed-wallet setup, and the collection lifetime model.

## Layout

- [`agentrag/`](./agentrag) — the plugin:
  [`.claude-plugin/plugin.json`](./agentrag/.claude-plugin/plugin.json) (manifest + config
  schema), [`.mcp.json`](./agentrag/.mcp.json) (MCP server wiring), and the
  [skill](./agentrag/skills/agentrag/SKILL.md).
- The plugin is published through the shared **agentx402 marketplace**
  ([`agentx402-ai/claude-plugins`](https://github.com/agentx402-ai/claude-plugins)), which
  references this directory by `git-subdir`. This repo carries no marketplace manifest of its own.

## License

[MIT](../LICENSE)
