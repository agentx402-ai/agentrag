# CLAUDE.md

The shared agent/contributor guide lives in **AGENTS.md** (cross-tool standard) —
commands, conventions, money-safety invariants, release process. Read it first:

@AGENTS.md

Claude Code specifics:

- After changing code, the gate is `npm run lint && npm test` (Biome + both
  workspace suites; `npm test` builds the client first).
- The money-safety regressions in `client/test/spend-caps.test.ts` and
  `client/test/payto.test.ts` are load-bearing — a failing one means your change
  reopened a real spend-safety hole (an uncapped paying path, an unpinned payee
  that lets a spoofed 402 be paid, or a composite ask priced above its authorized
  ceiling); fix the code, not the test.
- MCP server lives behind `agentrag mcp` (`cli/`); its tool annotations
  (read-only vs state-changing) must stay truthful — a paid tool (`rag_ask`,
  `rag_ingest`, `rag_extend`) is never `readOnlyHint`, so clients know to
  prompt a human before spending.
