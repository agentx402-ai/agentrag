import { AgentRagError } from "@agentrag/client";
import { privateKeyToAccount } from "viem/accounts";
import { parseFlags } from "../args";
import { peekStoredAccount, peekStoredWallet } from "../keystore";
import { EXIT, printError, printJson, type Writer } from "../output";

const KEY_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * What the wallet surfaces report. This exact object is printed by `wallet show` AND (Task 9)
 * returned by the rag_wallet_address MCP tool, so everything in it reaches a model's context:
 * it carries the public address and the keystore PATH only — never the private key.
 */
export interface WalletIdentity {
  /** The address that pays, or null when there is none (account-key mode, or no wallet yet). */
  address: `0x${string}` | null;
  /** Where the address came from — mirrors clientFromConfig's precedence. */
  source: "env" | "keystore" | "account-key" | "none";
  /** The keystore file backing the wallet (the file to back up); only for source "keystore". */
  path?: string;
  /** What to do next — funding/backup guidance, or why there is no address. */
  note?: string;
}

/** Normalize an env var the way config.ts's envStr does: unset/empty/whitespace -> undefined. */
function envStr(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

/**
 * True when the client would authenticate with an `ak_` bearer instead of a wallet. Mirrors
 * clientFromConfig exactly: an explicit AGENTRAG_ACCOUNT_KEY wins outright; otherwise a stored
 * account.json counts, but only when no AGENTRAG_PRIVATE_KEY is set.
 */
export function isAccountMode(env: NodeJS.ProcessEnv): boolean {
  if (envStr(env.AGENTRAG_ACCOUNT_KEY) != null) return true;
  return envStr(env.AGENTRAG_PRIVATE_KEY) == null && peekStoredAccount(env) != null;
}

/**
 * Resolve the wallet the client would actually pay from, WITHOUT minting one — `wallet show`
 * must be able to answer "is there a wallet yet?" without creating the answer. Precedence
 * mirrors clientFromConfig: an explicit AGENTRAG_PRIVATE_KEY wins, else the local keystore
 * wallet.
 *
 * Callers MUST resolve this BEFORE any future scrubSensitiveEnv() strips AGENTRAG_PRIVATE_KEY
 * from the environment (Task 9's MCP server); afterwards it would fall through to the keystore
 * and name an address the client never pays from.
 *
 * A corrupt wallet.json throws out of peekStoredWallet and is deliberately not caught: reporting
 * "no wallet yet" for an unreadable one would invite funding a freshly minted, different address.
 */
export function resolveWalletIdentity(
  env: NodeJS.ProcessEnv,
  accountMode: boolean,
): WalletIdentity {
  if (accountMode) {
    return {
      address: null,
      source: "account-key",
      note: "Account-key mode has no wallet — the ak_ bearer is the identity, and its credits are funded out-of-band via AgentKV.",
    };
  }
  const envKey = envStr(env.AGENTRAG_PRIVATE_KEY);
  if (envKey) {
    // A SET-but-malformed key is an ERROR, not "absent": every real op throws on it
    // (clientFromConfig -> privateKeyToAccount), so falling through to the keystore would
    // report an identity the client never uses — and invite funding it.
    if (!KEY_RE.test(envKey)) {
      throw new AgentRagError(
        "AGENTRAG_PRIVATE_KEY is set but malformed (expected 0x followed by 64 hex chars)",
        "invalid_config",
        0,
      );
    }
    return {
      address: privateKeyToAccount(envKey as `0x${string}`).address,
      source: "env",
      note: "Fund this address with USDC on Base. The key comes from AGENTRAG_PRIVATE_KEY — back it up yourself.",
    };
  }
  const stored = peekStoredWallet(env);
  if (stored) {
    return {
      address: stored.address,
      source: "keystore",
      path: stored.path,
      note: "Fund this address with USDC on Base, and back up this file — it holds the key that pays.",
    };
  }
  return {
    address: null,
    source: "none",
    note: "No wallet yet — one is minted automatically on the first paid use (ask / ingest / extend).",
  };
}

/**
 * `agentrag wallet show` — the only way to discover the auto-minted wallet's address (to fund
 * it) and its file (to back it up). Show only: the wallet is minted on first use, so a
 * `wallet new` would just be a second way to end up with an unfunded key.
 */
export function runWallet(
  args: string[],
  io: { stdout: Writer; stderr: Writer; env?: NodeJS.ProcessEnv },
): number {
  // parseFlags so a typo'd flag fails loud here too, rather than being silently ignored.
  const { positionals } = parseFlags(args);
  if (positionals[0] !== "show") {
    printError(io.stderr, "usage", "wallet show");
    return EXIT.USAGE;
  }
  const env = io.env ?? process.env;
  printJson(io.stdout, resolveWalletIdentity(env, isAccountMode(env)));
  return EXIT.OK;
}
