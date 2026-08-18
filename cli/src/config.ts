import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AgentRag,
  AgentRagError,
  type AgentRagOptions,
  isAccountKeyFormat,
} from "@agentrag/client";
import { privateKeyToAccount } from "viem/accounts";
import { agentragDir, getOrCreateStoredWallet, peekStoredAccount } from "./keystore";

/**
 * Hosted AgentRAG service — used when no endpoint is configured. This is a bare host, not a
 * versioned path: every client targets this host's /v1/rag/* routes. The endpoint default
 * lives here in the CLI layer only — the SDK's `endpoint` is required.
 */
export const DEFAULT_ENDPOINT = "https://api.agentx402.ai";

export interface ResolvedConfig {
  endpoint: string;
  network: string;
  maxSpendUsd?: number;
  maxSessionSpendUsd?: number;
  /** Wallet private key from AGENTRAG_PRIVATE_KEY (wallet/x402 mode). */
  privateKey?: `0x${string}`;
  /** The raw `ak_…` account bearer from AGENTRAG_ACCOUNT_KEY (account-key mode). */
  accountKey?: string;
}

/** Normalize an env var: undefined, empty, or whitespace-only -> undefined (trimmed). */
function envStr(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
}

/**
 * Parse a non-negative numeric ENV var. Unset, empty, or whitespace-only -> undefined (no cap —
 * the documented default). A set-but-malformed or negative value THROWS (fail closed): a typo'd
 * spend cap must not silently become "unlimited" on real funds. Values that arrive already
 * parsed from config.json go through numOrThrowVal instead — they are type-checked, not coerced.
 */
function numOrThrow(v: string | undefined, name: string): number | undefined {
  const s = envStr(v);
  if (s === undefined) return undefined;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${name} must be a non-negative number (got ${JSON.stringify(s)})`);
  }
  return n;
}

/**
 * The already-parsed (config.json) counterpart of numOrThrow. JSON.parse hands back whatever
 * the file contained, so the value is TYPE-checked rather than coerced: a quoted or
 * comma-decimal cap ("0,05") would coerce to NaN, and `usd > NaN` is always false — a cap that
 * silently permits every spend. Explicit null reads as "not set", the same as an absent field.
 */
function numOrThrowVal(v: unknown, name: string): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
    throw new AgentRagError(
      `${name} must be a non-negative number (got ${JSON.stringify(v)})`,
      "invalid_config",
      0,
    );
  }
  return v;
}

/**
 * Type-check a string field from config.json. JSON.parse can produce any type here, so an
 * `"endpoint": 8080` would otherwise flow on untouched and surface much later as a raw
 * TypeError from deep inside the client, instead of a config error naming the offending field.
 */
function strOrThrowVal(v: unknown, name: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || v.trim() === "") {
    throw new AgentRagError(`${name} must be a non-empty string`, "invalid_config", 0);
  }
  return v.trim();
}

/**
 * Read the on-disk config file (`<AGENTRAG_HOME|~/.agentrag>/config.json`). An ABSENT file
 * (ENOENT) returns null — the documented default of "no file config". Every other failure FAILS
 * LOUD as `invalid_config`, because this file can carry a spend cap and a non-production
 * endpoint: silently downgrading a truncated file (what a non-atomic write plus a crash leaves
 * behind), an unreadable one, or a non-object payload to "no config" would drop the persisted
 * cap AND retarget requests at the production default. Same ABSENT-vs-CORRUPT split
 * peekStoredAccount already makes for account.json. Secrets are NEVER read from here.
 */
export function readConfigFile(env: NodeJS.ProcessEnv): Partial<ResolvedConfig> | null {
  const file = join(agentragDir(env), "config.json");
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    // EACCES/EISDIR/… mean a config EXISTS but cannot be used — never run on defaults instead.
    throw new AgentRagError(
      `config file ${file} exists but could not be read: ${e instanceof Error ? e.message : String(e)}`,
      "invalid_config",
      0,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AgentRagError(
      `config file ${file} is not valid JSON — fix or remove it`,
      "invalid_config",
      0,
    );
  }
  // A JSON array/scalar would index to undefined on every field, i.e. read as an empty config.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AgentRagError(`config file ${file} must contain a JSON object`, "invalid_config", 0);
  }
  // Secrets are read from the ENVIRONMENT only — resolveConfig never sources privateKey/
  // accountKey from this file. A secret field here is therefore doubly wrong: silently inert
  // (the user thinks they configured auth and did not), and a real key sitting in a plaintext
  // config file. Fail closed and tell the operator to move it to env, rather than ignore it.
  for (const secretField of ["privateKey", "accountKey"] as const) {
    if (secretField in (parsed as Record<string, unknown>)) {
      throw new AgentRagError(
        `config file ${file} must not contain "${secretField}" — secrets are read from the ` +
          "environment only (AGENTRAG_PRIVATE_KEY / AGENTRAG_ACCOUNT_KEY); remove it from the file",
        "invalid_config",
        0,
      );
    }
  }
  return parsed as Partial<ResolvedConfig>;
}

export function resolveConfig(
  flags: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  readFile: (env: NodeJS.ProcessEnv) => Partial<ResolvedConfig> | null,
): ResolvedConfig {
  const file = readFile(env) ?? {};
  const f = flags as {
    endpoint?: string;
    network?: string;
    maxSpendUsd?: number;
    maxSessionSpendUsd?: number;
  };
  // File-sourced values are validated OUTSIDE the ?? chains below. Inside one, a winning flag or
  // env var short-circuits the check, so a malformed PERSISTED value would go uninspected — and
  // then become the active endpoint/cap on the first run that drops the override.
  const fileEndpoint = strOrThrowVal(file.endpoint, "endpoint (config.json)");
  const fileNetwork = strOrThrowVal(file.network, "network (config.json)");
  const fileMaxSpendUsd = numOrThrowVal(file.maxSpendUsd, "maxSpendUsd (config.json)");
  return {
    endpoint: f.endpoint ?? envStr(env.AGENTRAG_ENDPOINT) ?? fileEndpoint ?? DEFAULT_ENDPOINT,
    network: f.network ?? envStr(env.AGENTRAG_NETWORK) ?? fileNetwork ?? "eip155:8453",
    maxSpendUsd:
      f.maxSpendUsd ??
      numOrThrow(env.AGENTRAG_MAX_SPEND_USD, "AGENTRAG_MAX_SPEND_USD") ??
      fileMaxSpendUsd,
    // Deviation from the Scout template (deliberate, per the task brief): a real
    // --max-session-spend-usd FLAG is honored here too, not just the env var — Scout's
    // equivalent is env-only and there's no reason for that gap on a money control. No
    // config.json support for it (Scout doesn't have one for its own equivalent either).
    maxSessionSpendUsd:
      f.maxSessionSpendUsd ??
      numOrThrow(env.AGENTRAG_MAX_SESSION_SPEND_USD, "AGENTRAG_MAX_SESSION_SPEND_USD"),
    // secrets: env ONLY — never flags, never the config file
    privateKey: envStr(env.AGENTRAG_PRIVATE_KEY) as `0x${string}` | undefined,
    accountKey: envStr(env.AGENTRAG_ACCOUNT_KEY),
  };
}

/**
 * Build an SDK client. Raw private keys become a viem signer here — only { signer } |
 * { accountKey } reach the SDK.
 */
export function clientFromConfig(
  cfg: ResolvedConfig,
  opts?: { env?: NodeJS.ProcessEnv; notify?: (m: string) => void },
): AgentRag {
  const base = {
    endpoint: cfg.endpoint,
    network: cfg.network,
    maxSpendUsd: cfg.maxSpendUsd,
    maxSessionSpendUsd: cfg.maxSessionSpendUsd,
  };
  // Account-key mode: explicit env wins; else a stored account.json when no private key is set.
  const stored = cfg.privateKey ? null : peekStoredAccount(opts?.env);
  const accountKey = cfg.accountKey ?? (cfg.privateKey ? undefined : stored?.accountKey);
  if (accountKey) {
    if (!isAccountKeyFormat(accountKey)) {
      throw new Error("AGENTRAG_ACCOUNT_KEY must be of the form ak_<64 lowercase hex>");
    }
    return new AgentRag({ ...base, accountKey } satisfies AgentRagOptions);
  }
  // Wallet mode: use the configured private key or mint/reuse a local wallet.
  let privateKey = cfg.privateKey;
  if (!privateKey) {
    const w = getOrCreateStoredWallet(opts?.env);
    privateKey = w.privateKey;
    if (w.created) {
      opts?.notify?.(
        `created a new wallet ${w.address} (saved to ${w.path}). Fund it, then retry.`,
      );
    }
  }
  return new AgentRag({
    ...base,
    signer: privateKeyToAccount(privateKey),
  } satisfies AgentRagOptions);
}
