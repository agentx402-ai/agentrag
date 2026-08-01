# Contributing to AgentRAG

Thanks for your interest in improving the AgentRAG clients — the SDK, CLI, MCP server, and
Claude plugin.

## Development

Requirements: **Node >= 20** (CI floor; [`.nvmrc`](./.nvmrc) pins the recommended 22) and npm.

```bash
npm ci
npm run build      # build the packages (client, cli)
npm test           # typecheck + unit tests for client and cli
npm run lint       # biome: format check + lint
npm run format     # auto-fix formatting + safe lint issues
```

> **Build before test.** `@agentrag/cli`'s typecheck resolves `@agentrag/client` from its
> built `dist/`, so run `npm run build` before `npm test` on a clean checkout. CI does this for
> you.

### Layout

- `@agentx402-ai/core` — the shared platform SDK, in [its own repo](https://github.com/agentx402-ai/core); a published dependency here, not a workspace
- `client/` — `@agentrag/client`, the SDK
- `cli/` — `@agentrag/cli`, the CLI and `agentrag mcp` server (depends on the SDK)
- `plugin/` — the Claude Code plugin

## Pull requests

- Keep changes focused — one logical change per PR.
- Add or update tests for any behavior change; the money paths (spend caps, payee pinning, the
  authorized-ceiling guard, and the x402 signing path) are covered by unit tests and must stay
  green.
- Run `npm run lint`, `npm run build`, and `npm test` locally before pushing — CI runs the same.
- Never commit secrets, private keys, or `ak_` account keys. Test fixtures use the public
  Hardhat/Anvil test key and example endpoints only.

## Bugs and security

Open an issue for bugs and feature requests. For security vulnerabilities, follow
[SECURITY.md](./SECURITY.md) instead — do not open a public issue.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](./LICENSE).
