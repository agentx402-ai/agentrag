# Security Policy

The AgentRAG clients sign real USDC payment authorizations over x402, so we take security
reports seriously.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately via either:

- GitHub's [private vulnerability reporting](https://github.com/agentx402-ai/agentrag/security/advisories/new)
  (preferred), or
- email **contact@agentx402.ai** with a subject starting `SECURITY:`.

Please include a description, the affected package(s) and version(s), reproduction steps, and the
impact. We aim to acknowledge within 72 hours and will keep you updated through remediation. Please
give us a reasonable window to ship a fix before any public disclosure.

## Scope

This repository contains the **client** surface — `@agentrag/client` (SDK), `@agentrag/cli`
(CLI + MCP server), and the Claude plugin. The hosted AgentRAG service backend is operated
separately and is out of scope here. In scope: the client's signing, payment-authorization
handling, spend-cap and payee-pinning logic, key management, and dependency vulnerabilities.

## Threat model

The SDK signs **real USDC payment authorizations** (EIP-3009 `transferWithAuthorization`) to pay
for each call over x402. The guardrails against overspend are client-side, and they are what a
review must scrutinize hardest:

- **The SDK signs an amount it has bounded, never one the server can inflate.** For `ask`/`ingest`
  the server's exact quoted amount is signed verbatim from the `402` challenge, after the authorized
  ceiling check. `extend` is the one deliberate exception: its pre-auth `402` is a stateless
  placeholder quote (so it can't be used as a collection-size oracle), so the SDK signs a
  self-computed amount — the real per-block price — bounded above by an independent structural
  ceiling (`maxExtendAmountUsd`, from `MAX_CHUNKS`, not the server's chunk count). In all cases
  `buildPaymentHeader` pins the expected network and the canonical USDC token before signing, so a
  challenge that names a different chain or token is rejected.
- **Spend caps refuse, never silently cap.** `maxSpendUsd` / `AGENTRAG_MAX_SPEND_USD` (per call)
  and `maxSessionSpendUsd` / `AGENTRAG_MAX_SESSION_SPEND_USD` (cumulative) are checked BEFORE the
  challenge is signed; an over-cap op throws and signs nothing. A malformed cap value fails closed
  (throws) rather than becoming "unlimited".
- **`expectedPayTo` pins the recipient.** When set, any `402` challenge whose `payTo` differs is
  rejected (`payto_mismatch`) before the authorization is signed, so a spoofed or swapped payee
  cannot be paid.
- **The authorized ceiling is bound to the request shape, independent of the server's quote.** An
  `ask` with `sources` may trigger an implicit ingest, so the server can legitimately quote a
  composite price above the flat ask price. Before signing anything, the client computes its own
  ceiling from its pinned prices (`(pages + ceilAsk) × ingestPrice`, spec §11.3) and refuses any
  challenge that quotes more — the server's price is never trusted past that independently
  computed bound.

**AgentRAG v1 pays no publisher tolls.** There is no `maxTollUsd` option and no toll error codes;
every payment is between the caller and the AgentRAG service only. Do not reintroduce toll
handling from the AgentScout client — it does not apply here.

**Retrieval content is NOT encrypted.** Unlike AgentKV — which encrypts values client-side so the
server is zero-knowledge — AgentRAG stores and indexes ingested documents, and returns query
results, **in the clear server-side**. There is no encryption key and nothing zero-knowledge about
a collection: the service, and (for the transport hop) a network observer, can see ingested
content and retrieved chunks. Do not ingest secrets into a collection, and do not treat a
collection's contents as private.

**The account-key bearer is a full-ownership secret.** In the opt-in account-key mode, the raw
`ak_…` bearer token (`AGENTRAG_ACCOUNT_KEY`) *is* the account identity — presenting it lets the
holder spend the account's prepaid credits. Treat it with the same care as a wallet private key:
keep it (and the wallet key `AGENTRAG_PRIVATE_KEY`) in env or a secret manager, never a config
file or source control.

**Secrets are read from env / the local keystore only** — never from CLI flags or the config
file (a `privateKey`/`accountKey` field placed in `config.json` is rejected outright, not
silently ignored). The MCP server **scrubs the wallet and account keys from its own process
environment at startup** (once the client has captured them — see `cli/src/secrets.ts`:
`AGENTRAG_PRIVATE_KEY` / `AGENTRAG_ACCOUNT_KEY` and any `AGENTRAG_*` var whose name looks like key
material), so a tool that dumps the server's own env, or a child process it later spawns, cannot
read them back. This is best-effort in-process hygiene, not a sandbox — it does not reach a parent
launcher's environment. Keystore files are written `0600` in a `0700` directory.

## Known advisories

`npm audit` may report a high-severity advisory for **`ws`** (GHSA-96hv-2xvq-fx4p), pulled in
transitively through `viem`. AgentRAG's client uses `viem` **only for signing and address/hash
utilities** and never opens a WebSocket transport, so the affected code path is not reachable from
this SDK. This repository pins a patched `ws` via an `overrides` entry; downstream consumers resolve
`ws` through their own dependency tree, so keep `viem`/`ws` up to date (Dependabot is enabled here).

## Supported versions

The latest released minor of each `@agentrag/*` package receives security fixes.
