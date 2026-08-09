# AGENTS.md — agent/contributor guide for this repo

Cross-tool agent instructions (the [agents.md](https://agents.md) convention).
`CLAUDE.md` references this file; keep tool-specific notes there, shared truth here.

## What this repo is

Open-source **client surface** for AgentRAG — an agent-native, x402-paid retrieval
service (service at `api.agentx402.ai/v1/rag/*`; the server is not in this repo). npm-workspaces
monorepo:

| Workspace | Package | What it is |
|---|---|---|
| `client/` | `@agentrag/client` | SDK — x402 payments, spend caps, ask/ingest/extend/status |
| `cli/` | `@agentrag/cli` | CLI + `agentrag mcp` MCP server (wraps the client) |
| `plugin/` | (not published to npm) | Claude Code plugin wrapping the MCP server |

`@agentx402-ai/core` (shared x402/EIP-712 platform SDK) lives in its own repo
(`agentx402-ai/core`) and is consumed as a normal dependency.

## Commands

```bash
npm ci                 # install (root; workspaces hoisted)
npm run build          # client then cli (order matters — cli depends on client)
npm run typecheck      # tsc --noEmit, both workspaces
npm test               # builds client first (pretest), then client + cli suites (vitest)
npm run lint           # biome ci .   (CI gate — run before pushing)
npm run format         # biome check --write .
npm --workspace client test -- spend-caps   # one file, vitest filename filter
```

**Run `build` before `typecheck`, not after.** `client/package.json` points `types` at
`./dist/index.d.ts`, so `cli`'s typecheck resolves `@agentrag/client` through the BUILT
client, not its source. Typechecking straight after editing `client/src` therefore reports
`Cannot find module '@agentrag/client'` — a false failure that points at the import rather than
at anything actually wrong. `npm test` is safe on its own (a `pretest` builds the client
first); a standalone `npm run typecheck` is not. CI only ever runs build-then-test, which is
why this never fires there. Working order: `lint`, `build`, `typecheck`, `test`.

Git hooks come from `.githooks/` (wired by `npm ci` via `core.hooksPath`).

## Conventions

- TypeScript, ESM, Biome for lint+format. Match the existing comment density — this
  codebase explains *why*, especially around payment logic.
- Conventional commits: `type(scope): subject` (`feat(client): …`, `fix(cli): …`),
  imperative, with a short explanatory body for anything non-obvious. No trailers.
- Tests live in `<workspace>/test/`, colocated by feature (`spend-caps.test.ts`,
  `payto.test.ts`, …). New behavior ships with tests; bug fixes ship with a
  regression test that fails on the pre-fix code.
- This is a public repo: no scratch files, planning notes, or internal references in
  commits. `.superpowers/` is gitignored scratch — leave it that way.

## Money-safety invariants (do not weaken)

Client code here authorizes real USDC payments. Four invariants are load-bearing:

1. **Spend caps bound every paying path.** `maxSpendUsd` / `AGENTRAG_MAX_SPEND_USD`
   (per call) and `maxSessionSpendUsd` / `AGENTRAG_MAX_SESSION_SPEND_USD` (cumulative)
   are checked BEFORE the challenge is signed; an over-cap op throws `SpendCapError`,
   it never silently caps. A malformed cap value fails closed (throws), never "unlimited".
2. **`expectedPayTo` pins the recipient.** When set, a `402` challenge whose `payTo`
   differs is rejected (`payto_mismatch`) BEFORE the EIP-3009 authorization is signed.
3. **The authorized ceiling is computed from the request shape.** An `ask` with
   `sources` can trigger an implicit ingest, so the server may legitimately quote a
   composite price: `(pages + ceilAsk) × ingestPrice` (spec §11.3). The client computes
   that same ceiling from its OWN pinned prices (`ASK_BASE_USD`, `INGEST_PAGE_USD`, …)
   BEFORE any request, and refuses a challenge that quotes more than that ceiling —
   the server's price is never trusted past an independently computed bound.
4. **The SDK signs the challenge's exact amount.** The server's `402`-quoted price is
   signed verbatim (`buildPaymentHeader` pins the network, the canonical USDC token, and
   `expectedPayTo`); the SDK never signs a self-computed sum.

**AgentRAG v1 pays no publisher tolls.** There is no `maxTollUsd` option and no
toll-related error codes (spec §11.2) — every payment here is between the caller and
the AgentRAG service only. Do not reintroduce toll concepts from the AgentScout
client; they do not apply here.

**Retrieval content is NOT encrypted.** Unlike AgentKV — which encrypts values
client-side so the server is zero-knowledge — an AgentRAG collection is stored and
indexed in the clear on the server: ingested documents, chunks, and query results are
all plaintext server-side. Do not treat a collection as private, and do not ingest
secrets into it.

Error-code strings (`insufficient_credits`, `payto_mismatch`, `collection_expired`, …) and
the x402/EIP-712 domain constants are pinned to the server's canon; parity tests here mirror
server behavior. Never rename or repurpose one unilaterally — client and service must change
in lockstep. The deterministic regressions in `client/test/spend-caps.test.ts` and
`client/test/payto.test.ts` pin invariants 1–2; if your change breaks one, the change is
wrong, not the test.

## Versioning & release

`RELEASING.md` is authoritative. Six in-repo version sources move in lockstep — both
`package.json`s, `client/src/index.ts` `VERSION`, `cli/src/version.ts` `VERSION`,
`plugin/agentrag/.claude-plugin/plugin.json` `version`, and `plugin/agentrag/.mcp.json`'s
`@agentrag/cli@<version>` runtime pin — plus a seventh cross-repo pin, the marketplace
`source.ref` synced on release. CI's `versions` job cross-checks ALL SIX in-repo sources AND
the cli→client dependency range (`@agentrag/client` must be `^<clientVersion>`); update them
together, by hand. The runtime pin matters because without it `.mcp.json` spawns whatever
`@agentrag/cli` is latest at install time, so the lockstep never bound what actually runs.
Publishing happens via a GitHub Release → the `publish.yml` OIDC trusted-publishing workflow
(client before cli — dependency order). Never `npm publish` from a laptop.

## Security

See `SECURITY.md`. Never print, log, or commit account keys (`ak_…`) or wallet private keys —
in code, tests, or your own command output. Secrets are read from env / the local keystore
only, never from CLI flags or the config file. Retrieval content is **not** encrypted (it is
stored in the clear server-side). Report vulnerabilities per `SECURITY.md`, not via public issues.
