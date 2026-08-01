// cli/src/secrets.ts
//
// Guards key material in the MCP server's own process env. `scrubSensitiveEnv` strips the
// wallet/account key once the client has captured what it needs, so an agent-controlled child
// process (or any tool that dumps its own env) can never read it back. Scrub-only: unlike
// agentkv/agentscout's secrets.ts, AgentRAG's MCP surface has no LLM-free secret tools
// (set_from_env / get_to_file / run_with_secret) to share read/write helpers with — there is
// nothing in the six-tool surface (rag_ask/ingest/extend/status/delete/wallet_address) that
// reads or writes a caller-named secret, so this file carries only the guard the MCP server
// itself needs at startup.

// Env vars that hold key material the model must never see. Stripped from the MCP server's own
// env at startup (startMcp, AFTER resolveWalletIdentity has captured what it needs — see its
// own doc comment for why the ordering matters).
const SENSITIVE_ENV = ["AGENTRAG_PRIVATE_KEY", "AGENTRAG_ACCOUNT_KEY"];
// Defense in depth: any AGENTRAG_ env var whose NAME looks like private/funded key material is
// ALSO protected, so a future AGENTRAG_*_PRIVATE_KEY / _PAYER_KEY var is covered by default
// without a code change. Scoped to the AGENTRAG_ prefix so it never touches a user's UNRELATED
// third-party secret.
const SENSITIVE_ENV_PATTERN =
  /^AGENTRAG_.*(PRIVATE_KEY|PAYER_KEY|ENCRYPTION_KEY|MNEMONIC|SEED_PHRASE)$/i;

/** True if an env var name holds AgentRAG's own protected key material (explicit list or pattern). */
export function isSensitiveEnvName(name: string): boolean {
  return SENSITIVE_ENV.includes(name) || SENSITIVE_ENV_PATTERN.test(name);
}

/** Delete every protected key var from `env` once the client has captured what it needs. */
export function scrubSensitiveEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const k of Object.keys(env)) {
    if (isSensitiveEnvName(k)) delete env[k];
  }
}
