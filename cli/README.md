# @agentrag/cli

The command-line client and MCP server for
[AgentRAG](https://github.com/agentx402-ai/agentrag) — an agent-native
**retrieval-augmented-generation** service over your own documents, paid per call over
[x402](https://x402.org).

No setup: AgentRAG mints and manages a local wallet for you on first run and defaults to the
hosted service. Just run a command:

```bash
npx @agentrag/cli ingest --sources "https://example.com/docs/**" --collection my-docs
agentrag ask "what does the refund policy say?" --collection my-docs
agentrag ask "what about international orders?" --sources "https://example.com/pricing" --wait
agentrag extend my-docs --days 30
agentrag status my-docs
agentrag delete my-docs
agentrag wallet show
```

No wallet set? AgentRAG mints and manages a local wallet on first use (a `0600` keystore under
`~/.agentrag`) and prints its address — fund that address with USDC on Base, then retry.

## Commands

```text
agentrag ask <query> [--sources URL...] [--collection ID] [--top-k N] [--mode hybrid|dense|bm25] [--max-pages N] [--wait]
agentrag ingest [--sources URL...] [--documents FILE] [--collection ID] [--model ID] [--max-pages N] [--refresh]
agentrag extend <collection> --days 30|60|90
agentrag status <collection>
agentrag delete <collection>
agentrag wallet show
agentrag mcp
agentrag --version
```

- **`ask`** — ask a question. `--sources` (repeatable; each an exact URL or a trailing `/**`
  same-origin crawl root) ingests on demand into a collection when needed; `--collection` targets
  one you already built. A source set too large to ingest inline resolves as a pending status
  instead of an error — pass `--wait` to block until it resolves with the real answer.
- **`ingest`** — explicitly index `--sources` and/or a `--documents FILE` (a JSON array of
  `{text, title?, url?}` objects) into a collection; the only way to index raw text directly or
  force a `--refresh` re-fetch.
- **`extend`** — push a collection's expiry out by 30, 60, or 90 days.
- **`status`** / **`delete`** — free: read a collection's metadata and ingest state, or
  permanently purge it.
- **`wallet show`** — print the address AgentRAG pays from (or `null` if none exists yet) and the
  keystore file backing it, without minting a wallet as a side effect.
- **`mcp`** — run the MCP server (see below).

Every command other than `mcp` prints JSON to stdout and exits `0` on success; a failure prints
`{"error", "code"}` (sometimes with a `"hint"`) to stderr and exits non-zero. An unknown or
misplaced flag is a usage error, not a silently dropped no-op — each command only accepts its own
flags plus the four global ones below.

## Two ways to pay (auto-detected)

- **Wallet-as-payer** (default): a signable wallet pays each call inline via x402 and is itself
  the identity. The auto-provisioned wallet uses this.
- **Account-key**: for a *managed* wallet that can't sign (e.g.
  [awal](https://www.npmjs.com/package/awal)), an opaque `ak_…` bearer token is the identity and
  calls debit **prepaid credits** funded out-of-band via AgentKV.

```bash
# Fund an account out-of-band from ANY signing wallet (via AgentKV), then use just the bearer:
export AGENTRAG_ACCOUNT_KEY=ak_...
agentrag ask "what does the refund policy say?" --collection my-docs   # debits prepaid credits
```

`AGENTRAG_ACCOUNT_KEY` wins whenever it's set — even if `AGENTRAG_PRIVATE_KEY` is also set, the
account key is used and the private key is ignored. Otherwise wallet mode applies: an explicit
`AGENTRAG_PRIVATE_KEY`, else a previously-saved account key (if any), else the auto-minted local
wallet. AgentRAG pays no publisher tolls in either mode.

## Pricing

Wallet-mode calls settle in USDC via x402; account-key calls debit credits priced 20% cheaper.
The two are mutually exclusive per client — never both on the same call.

| Op | Price |
|----|-------|
| `ask` (no ingest needed) | flat $0.008 |
| `ingest` | $0.005 per page or document |
| `extend` | $0.01 per 5,000-chunk block (minimum 1, capped at 5) × `days / 30` |

An `ask` whose `--sources` need ingesting settles as **one** composite, ingest-denominated
charge — never a separate second payment. `status`, `delete`, and `wallet show` are always free.
See the [SDK README](../client) for the full usage/refund accounting (`totalPriceUsd`, spend
caps, collection lifetime).

## Configuration

Secrets come from the environment only — never the config file.

| Variable | Description |
|----------|--------------|
| `AGENTRAG_PRIVATE_KEY` | Wallet key (hex). Unset → a local wallet is auto-provisioned on first use. |
| `AGENTRAG_ACCOUNT_KEY` | `ak_…` bearer token — selects account-key mode (wins over a private key when both are set). |
| `AGENTRAG_ENDPOINT` | Service URL; defaults to `https://api.agentx402.ai`. |
| `AGENTRAG_NETWORK` | `eip155:8453` (Base mainnet, default) or `eip155:84532` (Base Sepolia). |
| `AGENTRAG_MAX_SPEND_USD` | Per-call USD spend cap. A malformed value fails closed. |
| `AGENTRAG_MAX_SESSION_SPEND_USD` | Cumulative, instance-lifetime USD cap (opt-in). |
| `AGENTRAG_HOME` | Base dir for the local keystore/config (default `~/.agentrag`). |

`--endpoint`, `--network`, `--max-spend-usd`, and `--max-session-spend-usd` are also accepted as
flags on any command (a flag wins over the matching environment variable). `wallet show` is the
one exception — it takes no flags at all, not even these.

## MCP server

`agentrag mcp` runs an MCP server over stdio exposing `rag_ask`, `rag_ingest`, and `rag_extend`
(the three paid verbs), plus the free `rag_status`, `rag_delete`, and `rag_wallet_address` (find
the address to fund), to Claude Desktop / Code / Cursor and any MCP client.

The paid tools are annotated as **state-changing** (never `readOnlyHint`) so a client knows to
prompt a human before spending; `rag_delete` is the one tool where `destructiveHint: true` is the
truthful annotation (free, but genuinely irreversible). **stdout is the JSON-RPC channel** — every
diagnostic (the auto-provisioned-wallet notice, a missing-session-cap warning) goes to stderr
instead. The wallet or account key is scrubbed from the server's own environment at startup, once
the client and paying identity are resolved, so an agent-controlled child process can never read
it back.

With no `AGENTRAG_MAX_SESSION_SPEND_USD` set, the server warns on stderr at startup: an MCP
session has no built-in cumulative spend bound otherwise, only whatever per-call cap you've set.

See the [monorepo README](https://github.com/agentx402-ai/agentrag#readme) and
[`plugin/`](../plugin) for the Claude Code plugin, which wraps this same server.

## License

[MIT](./LICENSE)
