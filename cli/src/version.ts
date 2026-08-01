// Single source of truth for the CLI version — `agentrag --version` and the MCP handshake.
// Kept in lockstep with package.json (and the other four version sources) by the CI
// `versions` job (Task 11's scripts/check-versions.mjs) — lockstep source 4 of 6.
export const VERSION = "0.1.0";
