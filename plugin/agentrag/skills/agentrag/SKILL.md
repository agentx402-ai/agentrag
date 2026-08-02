---
name: agentrag
description: Use AgentRAG to ingest your own documents or URLs into a collection (hybrid BM25 + vector search) and ask grounded questions against them, extend a collection's lifetime, check its status, or delete it. Paid per call in USDC via x402 — wallet-native by default (your wallet pays, no signup), with an opt-in account-key (ak_ bearer) mode for managed wallets. Use for grounding an agent in your own documents without hand-rolling a retrieval pipeline or payment. AgentRAG has no publisher tolls; account-key credits are funded out-of-band via AgentKV.
---

# AgentRAG Skill

AgentRAG turns your own documents into agent-ready retrieval: give it URLs, a same-origin
crawl root, or raw text, and it ingests them into a named **collection** — combining **hybrid
BM25 + vector search** — then answers questions against that collection with grounded source
chunks. Every paid call settles in real USDC on Base via the x402 protocol — no accounts, no
API keys, no hand-rolled `PAYMENT-SIGNATURE` signing. The service lives at
`https://api.agentx402.ai/v1/rag/*`.

You hold **one AgentRAG identity**, in one of two shapes (auto-detected by the client):

- **Wallet-as-payer** (the default): a signable EVM wallet pays each call inline via x402.
  AgentRAG mints and manages a local wallet on first use — fund it and go, no sign-up.
- **Account-key**: for a *managed* wallet that can't sign, an opaque `ak_…` **bearer token**
  identifies the account and debits **prepaid credits**. Credits are funded out-of-band via
  AgentKV (see **Account-key mode & funding** below).

> **Content is NOT encrypted.** Unlike AgentKV — which encrypts values client-side so the
> server is zero-knowledge — a collection is stored and indexed in the clear server-side. It
> is your document content by definition; there is no encryption key and nothing
> zero-knowledge about it. Do not ingest secrets into a collection.

---

## When to use AgentRAG

Use AgentRAG when you need:

- **Grounded answers over your own documents** — ingest URLs, a crawl root, or raw text once,
  then ask questions against that collection repeatedly without re-fetching or re-embedding.
- **On-demand grounding** — call `rag_ask` with `sources` directly; if the target collection
  doesn't have them yet, it ingests first, automatically.
- **Structured, cited retrieval** — get back the actual matched chunks alongside the answer,
  so you (or the calling agent) can verify or cite the source.
- **Long-lived knowledge bases** — `rag_extend` a collection's expiry before it lapses, rather
  than re-ingesting from scratch.

Do NOT use AgentRAG for:

- **Secrets or credentials.** A collection is stored and indexed in the clear; it is not a
  secret store (use AgentKV's secret-safe tools for that).
- **Live web fetches with no reuse.** A single throwaway page read with no follow-up questions
  is what AgentScout's `scout_read` is for — AgentRAG's ingest step is meant to be amortized
  over repeated `ask` calls against the same collection.
- **Zero-budget contexts.** `rag_ask`, `rag_ingest`, and `rag_extend` each cost real USDC; check
  your spend cap before a loop or a bulk ingest.

---

## Available MCP Tools

The `agentrag` MCP server exposes six tools — three paid verbs and three free ones:

| Tool | Description | Cost |
|------|-------------|------|
| `rag_ask` | Ask a question over a collection (hybrid BM25 + vector retrieval). If `sources` names URLs the collection hasn't indexed yet, ingests them first, on demand. Set `wait:true` to block until a needed ingest finishes and get the real answer in one call. | $0.008 flat, or a composite ingest-denominated charge when an ingest is triggered |
| `rag_ingest` | Explicitly ingest `sources` (URLs or a `/**` crawl root) and/or raw `documents` into a named collection — the only way to index documents directly or force a `refresh` re-fetch. | $0.005 per page/document unit |
| `rag_extend` | Push a collection's expiry out by 30, 60, or 90 days. Priced on the collection's real chunk count, not a flat rate. | $0.01 per 5,000-chunk block, × days/30 |
| `rag_status` | Read a collection's metadata: embedding model, page/chunk counts, timestamps, and any in-flight ingest job's state. Owner-gated. | **Free** |
| `rag_delete` | Immediately and permanently delete an owned collection — there is no undo. Owner-gated. | **Free** |
| `rag_wallet_address` | Return the address AgentRAG pays from, plus the local keystore file backing it. Purely local — no network call. Never returns the private key. | **Free** |

> **AgentRAG has no publisher tolls.** Unlike AgentScout, every payment here is between you and
> the AgentRAG service only — there is no toll cap to configure and no toll error path.

---

## Paying & spend caps

Two ceilings bound what an AgentRAG session can spend. Set them in the plugin config (run
`/plugin` to edit) or as env vars for the CLI:

- **`maxSpendUsd`** (`AGENTRAG_MAX_SPEND_USD`) — refuse any *single* call that would cost more
  than this.
- **`maxSessionSpendUsd`** (`AGENTRAG_MAX_SESSION_SPEND_USD`) — refuse further calls once
  cumulative spend across the whole session exceeds this.

Caps **refuse** — a paid tool over the ceiling throws a `SpendCapError` rather than silently
capping and spending less. The SDK signs the server's exact `402` challenge amount for
`ask`/`ingest` (never a self-computed one), and computes its own ceiling from the request shape
before signing anything (see the client README's **Money-safety** section for the exact rule).
`rag_status` and `rag_wallet_address` are free and never count against a cap.

---

## Account-key mode & funding

Account-key mode uses an `ak_…` bearer token instead of a signing wallet and debits **prepaid
credits**, at 80% of the wallet-mode price. Two things are specific to AgentRAG:

- **AgentRAG has no deposit route.** It does not mint or fund accounts — there is no
  `rag/deposit` endpoint. `ak_` credits are funded **out-of-band via AgentKV**, which shares the
  same account ledger:

  ```bash
  # Fund the ak_ account from ANY signing wallet (via AgentKV's deposit route):
  awal x402 pay https://api.agentx402.ai/v1/account/deposit \
    --headers '{"Authorization":"Bearer ak_..."}'
  ```

  The credits that deposit buys are then spendable by AgentRAG under the same `ak_` bearer.

- **`rag_extend`'s pricing read is skipped in account-key mode.** In wallet mode, `extend`
  reads the collection's real chunk count via a free status call before signing the real
  computed price. Account-key mode skips that read — the worker debits the real price directly
  from prepaid credits either way, so there is nothing extra to configure.

---

## Collection lifetime

A collection's expiry is not fixed at creation — it can slide forward on paid use, but only
conditionally, and the safe remedy is `rag_extend`, not "ask it again":

- `rag_ingest` slides the expiry only when it actually indexes at least one new page.
  Re-ingesting sources the collection already has appends nothing and does **not** slide — and
  in wallet mode still settles the quoted amount for the attempt. Do not rely on a re-ingest as
  a keep-alive; use `rag_extend` to control lifetime instead.
- `rag_ask` slides it **only** when the query actually matched. A no-match never settles
  anything on the ask leg itself — but on a **composite** ask (one that triggered an on-demand
  ingest), the ingest leg already settled before the query ran, so a no-match still cost that
  ingest even though the ask stays free. Neither a no-match nor an idempotency replay extends
  the collection — so relying on query traffic to keep a collection alive can silently fail.
- **Expiry is terminal.** Neither paid traffic nor `rag_extend` revives an already-expired
  collection — recovery is re-ingesting from scratch. Call `rag_status` to check `expires_at`
  and extend proactively if you want the lifetime under your own control rather than contingent
  on query traffic.

---

## One-Time Setup

Install the plugin from Claude Code's marketplace — the exact `/plugin marketplace add` and
`/plugin install` commands are in the plugin's `README.md` (`plugin/README.md`). After install,
Claude Code **prompts** for the config and threads it into the MCP server for you.

### 1. Credentials (entered at install, not via shell env)

| Config | Required | Description |
|--------|----------|-------------|
| Wallet private key | No | Optional — leave blank and AgentRAG mints + manages a local wallet on first use (then fund it). To bring your own: an EVM private key (hex), the wallet that pays. |
| Account key | No | An `ak_…` bearer token for managed-wallet (credit) mode. Funded out-of-band via AgentKV. If a wallet private key is also set, the account key silently wins and the wallet key is ignored. |
| AgentRAG endpoint | No | The hosted API; defaults to `https://api.agentx402.ai`. |
| Network | No | `eip155:8453` (Base mainnet, default) or `eip155:84532` (Base Sepolia testnet). |
| Max per-operation spend (USD) | No | Refuse any single call that would cost more than this; empty = no per-op cap. |
| Max session spend (USD) | No | Refuse calls once cumulative session spend exceeds this; empty = no cap. |

Re-run `/plugin` to change these later. Verify the server loaded with `/mcp` (you should see
the `agentrag` server and its six tools).

### 2. Fund the payer

- **Wallet mode:** send USDC to your wallet address on Base — asks/ingests/extends are then
  paid inline via x402. Don't have a wallet? Leave the private-key config blank — AgentRAG
  mints and manages a local wallet on first use — then fund the address `rag_wallet_address`
  prints.
- **Account-key mode:** deposit to AgentKV's `/v1/account/deposit` under your `ak_` bearer (see
  **Account-key mode & funding** above) — AgentRAG debits those shared credits.
