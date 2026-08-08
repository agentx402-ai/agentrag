# Changelog

All notable changes to this project are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project adheres to [SemVer](https://semver.org/).

## [0.1.1] — 2026-08-08

### Changed

- **`client` now depends on `@agentx402-ai/core@^0.4.0`** (was `^0.3.0`). Core 0.4.0 added
  `breakdown` and `expiring_soon` to `UsageBlock`, mirroring fields the AgentRAG worker
  already emits — `expiring_soon` in particular is an AgentRAG concept: it is set on a
  response when a collection is inside the final 24h of its lifetime, the caller's cue to
  `extend()` before the collection is lost. A caret on a `0.x` version pins the minor, so
  `^0.3.0` could never resolve 0.4.0 — `@agentrag/client@0.1.0` saw neither field. This is
  types-only (the JSON already arrived on the wire either way), but without the type a
  caller could not reference `usage.expiring_soon` without widening it by hand.
- `cli`'s dependency on `@agentrag/client` bumped to `^0.1.1` to match.

## [0.1.0] — 2026-08-08

### Added

- Initial release: `@agentrag/client` (the SDK — x402 payments, spend caps,
  ask/ingest/extend/status), `@agentrag/cli` (`agentrag` CLI plus the `agentrag mcp` MCP
  server), and a Claude Code plugin wrapping the MCP server.
