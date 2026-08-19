# AgentRAG

Open-source clients for **AgentRAG** — an agent-native retrieval service paid per call over
[x402](https://x402.org). Give it your own documents or URLs, **ingest** them into a
collection, then **ask** questions and get back grounded answers with source chunks — every
paid call settling in **USDC** on Base, with no signup and no API keys.

There are **two ways to pay**, auto-detected by the client:

- **Wallet-as-payer** (the default): a signable EVM wallet pays each call inline via x402.
  AgentRAG mints and manages a local wallet on first use, so an agent "just works" once that
  wallet is funded.
- **Account-key** (for *managed* wallets that can't sign — e.g. [awal](https://www.npmjs.com/package/awal)):
  an opaque `ak_…` **bearer token** identifies the account and debits **prepaid credits**.
  Credits are funded out-of-band via AgentKV, so any signing wallet can fund the account and
  calls carry only the bearer.

Retrieval content is **not** encrypted — a collection is stored and indexed in the clear
server-side (unlike AgentKV, which encrypts values client-side). Do not ingest secrets into a
collection.

This repository holds the **client surface** — the SDK, CLI, MCP server, and Claude plugin. The
AgentRAG service (the backend) is operated separately; these clients talk to it over the
public x402 + EIP-712 protocol.

## Packages

| Path | Package | What |
|------|---------|------|
| [`client/`](./client) | `@agentrag/client` | TypeScript SDK — sign + pay + ask/ingest |
| [`cli/`](./cli) | `@agentrag/cli` | the `agentrag` command-line, and `agentrag mcp` (MCP server) |
| [`plugin/`](./plugin) | — | Claude Code plugin (wraps the MCP server) |

## npm scopes

Two npm scopes separate the **platform** from the **service**:

- **`@agentx402-ai/*`** — the **platform scope**: `@agentx402-ai/core`, a shared SDK for auth,
  payment, usage tracking, error handling, and retry logic, consumed by every agentx402 service.
  It lives in its own repo ([agentx402-ai/core](https://github.com/agentx402-ai/core)) and is a
  published dependency of the packages here.
- **`@agentrag/*`** — the **RAG service scope**: `@agentrag/client` and `@agentrag/cli`
  (this repo), which depend on `@agentx402-ai/core` for shared plumbing.

Keeping `@agentx402-ai/core` in its own repo lets sibling services (e.g. `@agentkv/client`)
share it without depending on the AgentRAG repo.

## Quick start (SDK)

```bash
npm install @agentrag/client
```

```ts
import { AgentRag } from "@agentrag/client";
import { privateKeyToAccount } from "viem/accounts";

const rag = new AgentRag({
  signer: privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`),
  endpoint: "https://api.agentx402.ai",
  maxSpendUsd: 0.05, // optional: refuse any single call over $0.05
});

// ask over a URL — ingests on first use (may take a while for a large source);
// askAndWait polls until ingest completes, then answers from the collection
const { collection, chunks } = await rag.askAndWait("What does the refund policy say?", {
  sources: ["https://example.com/docs/**"],
});

// ask again against the same collection — no re-ingest, priced at the flat ask rate
const again = await rag.ask("What about international orders?", { collection });

// ingest documents directly (no crawl) into a named collection
await rag.ingest({
  documents: [{ text: "...", title: "Policy" }],
  collection: "my-docs",
});

// extend a collection's lifetime before it expires
await rag.extend("my-docs", 30);

// status/delete are free, identity-signed ops — no payment involved
const status = await rag.status("my-docs");
await rag.delete("my-docs");
```

## CLI

```bash
npm install -g @agentrag/cli
export AGENTRAG_PRIVATE_KEY=0x...             # endpoint defaults to https://api.agentx402.ai
agentrag ask "What does the refund policy say?" --sources "https://example.com/docs/**" --wait
agentrag ingest --sources "https://example.com/docs/**" --collection my-docs
agentrag extend my-docs --days 30
agentrag status my-docs
agentrag delete my-docs
```

No wallet? Leave `AGENTRAG_PRIVATE_KEY` unset and AgentRAG mints and manages a local wallet
on first use (a `0600` keystore under `~/.agentrag`), printing its address — fund that address
with USDC on Base, then retry. Cap spend any time with `AGENTRAG_MAX_SPEND_USD` (per call) and
`AGENTRAG_MAX_SESSION_SPEND_USD` (cumulative); a malformed value fails closed.

### Account-key mode (works with awal / any managed wallet)

For a *managed* wallet that can't sign (e.g. awal), use an account key funded out-of-band via
AgentKV; every call then carries only the bearer and debits the account's prepaid credits:

```bash
export AGENTRAG_ACCOUNT_KEY=ak_...            # a bearer minted + funded via AgentKV
agentrag ask "What does the refund policy say?" --collection my-docs   # debits prepaid credits
```

The client auto-selects account-key mode when `AGENTRAG_ACCOUNT_KEY` is set (or a stored
account key exists and no `AGENTRAG_PRIVATE_KEY` is set); otherwise it uses the wallet.
AgentRAG pays no publisher tolls — there is no toll flag or toll error path in either mode.

## MCP server / Claude plugin

`agentrag mcp` exposes the service as six MCP tools — `rag_ask`, `rag_ingest`, and `rag_extend`
(the three paid verbs), plus the free `rag_status` (check a collection's ingest progress and
lifetime), `rag_delete` (purge a collection), and `rag_wallet_address` (the address to fund) —
for Claude Desktop / Code / Cursor. The paid tools are annotated as state-changing (never
`readOnlyHint`) so a client knows to prompt a human before spending.

The [`plugin/`](./plugin) directory packages this as an installable **Claude Code plugin**. In
Claude Code:

```text
/plugin marketplace add agentx402-ai/claude-plugins
/plugin install agentrag@agentx402
```

Claude Code then prompts for your wallet private key (stored in your OS keychain) and the
optional AgentRAG endpoint (defaults to the hosted service), and auto-starts the MCP server —
verify with `/mcp`. Full steps: [`plugin/README.md`](./plugin/README.md).

## How it works

- **Pay per call over x402.** Each paid verb (`ask`, `ingest`, `extend`) is priced by the
  server's `402` challenge and settled in USDC on Base via x402 (EIP-3009
  `transferWithAuthorization`). For `ask`/`ingest` the SDK signs the challenge's **exact quoted
  amount** after checking it against a ceiling it computed itself; `extend` signs a self-computed
  price (its `402` is a deliberately stateless quote) bounded by an independent structural ceiling.
  Either way the SDK pins the network, the canonical USDC token, and (when you set `expectedPayTo`)
  the recipient before signing.
- **The authorized ceiling follows the request shape.** An `ask` with `sources` can trigger an
  implicit ingest, so the server may legitimately quote more than the flat ask price. Before
  signing anything, the client computes its own ceiling from its pinned prices and refuses any
  challenge that quotes above it — the server's price is never trusted past that independently
  computed bound, and no publisher toll is ever added on top (AgentRAG pays none).
- **Wallet-as-payer, or account-key credits.** In wallet mode a signable wallet pays each call
  inline and is itself the identity. In account-key mode an opaque `ak_…` bearer is the identity
  and calls debit prepaid credits funded out-of-band via AgentKV — so any signing wallet can
  fund the account, decoupled from the calls.
- **Client-side spend caps.** `maxSpendUsd` (per call) and `maxSessionSpendUsd` (cumulative)
  refuse — never silently cap — any op that would exceed them, checked before the challenge is
  signed.
- **No encryption.** A collection is stored and indexed in the clear server-side; there is no
  encryption key and nothing zero-knowledge about it (unlike AgentKV). Do not ingest secrets.

## License

[MIT](./LICENSE)
