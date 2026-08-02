import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type AgentRag, AgentRagError, AgentXError, SpendCapError } from "@agentrag/client";
import { parseFlags, UsageError } from "./args";
import { parseAskArgs, runAsk } from "./commands/ask";
import { parseDeleteArgs, runDelete } from "./commands/delete";
import { parseExtendArgs, runExtend } from "./commands/extend";
import { parseIngestArgs, runIngest } from "./commands/ingest";
import { parseStatusArgs, runStatus } from "./commands/status";
import { runWallet } from "./commands/wallet";
import { clientFromConfig, readConfigFile, resolveConfig } from "./config";
import { EXIT, printError, type Writer } from "./output";
import { VERSION } from "./version";

const HELP = `agentrag — x402-paid retrieval-augmented generation over your own documents

Usage:
  agentrag ask <query> [--sources URL...] [--collection ID] [--top-k N] [--mode hybrid|dense|bm25] [--max-pages N] [--wait]
  agentrag ingest [--sources URL...] [--documents FILE] [--collection ID] [--model ID] [--max-pages N] [--refresh]
  agentrag extend <collection> --days 30|60|90
  agentrag status <collection>
  agentrag delete <collection>
  agentrag wallet show
  agentrag mcp
  agentrag --version

Secrets come from env only: AGENTRAG_PRIVATE_KEY | AGENTRAG_ACCOUNT_KEY.
`;

export async function runCli(
  argv: string[],
  deps: {
    client?: AgentRag;
    stdout: Writer;
    stderr: Writer;
    env?: NodeJS.ProcessEnv;
  },
): Promise<number> {
  const env = deps.env ?? process.env;
  const { stdout, stderr } = deps;
  const [cmd, ...rest] = argv;

  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
    stdout(HELP);
    return EXIT.OK;
  }
  if (cmd === "-V" || cmd === "--version" || cmd === "version") {
    stdout(`${VERSION}\n`);
    return EXIT.OK;
  }
  const KNOWN = new Set(["ask", "ingest", "extend", "status", "delete"]);
  if (cmd !== "mcp" && cmd !== "wallet" && !KNOWN.has(cmd)) {
    printError(
      stderr,
      "usage",
      `unknown command: ${cmd}`,
      "commands: ask ingest extend status delete wallet mcp (run `agentrag --help`)",
    );
    return EXIT.USAGE;
  }

  // EVERY command dispatches inside this one try/catch, so a config/keystore failure always
  // reaches the operator as the same typed `{error, code}` line on stderr — mirrors
  // agentscout/cli's cli.ts, which closed exactly this gap: `mcp` and `wallet` used to be
  // dispatched ABOVE the try/catch, so their throws (resolveConfig/readConfigFile on a corrupt
  // config.json, peekStoredAccount on a corrupt account.json) escaped runCli instead — as an
  // unhandled rejection with a raw stack trace on the mcp path, since nothing .catch()es that
  // promise. Fail-closed either way (no server starts, nothing spends), but the operator got a
  // stack trace instead of the reason.
  try {
    if (cmd === "mcp") {
      const { startMcp } = await import("./mcp.js");
      // `await`, not a bare return: returning the promise would hand the rejection back to the
      // caller UNCAUGHT, which is precisely the bug this try/catch exists to close.
      return await startMcp({ env, stderr });
    }
    if (cmd === "wallet") {
      // Dispatched BEFORE the shared client construction below: clientFromConfig MINTS a
      // wallet when none exists, and `wallet show` must report "no wallet yet" without
      // creating one.
      return runWallet(rest, { stdout, stderr, env });
    }
    const cfg = resolveConfig(parseFlags(rest).flags, env, () => readConfigFile(env));
    // Validate the command's OWN arguments (required positionals, its per-command flag
    // allowlist, and any flag-value checks such as extend's --days enum) BEFORE the client
    // construction below — clientFromConfig mints and persists a wallet on first use
    // (config.ts), so a usage error must never get that far. Each parseXxxArgs is the exact
    // check runXxx itself runs (and calls again) — see parseAskArgs's doc comment — so there is
    // one source of truth for what counts as valid; a parseFlags-level throw (unknown/
    // disallowed flag, bad value) still propagates straight to mapError below, unchanged.
    if (cmd === "ask") {
      const parsed = parseAskArgs(rest);
      if (!parsed.ok) return usageFail(stderr, parsed.message);
    } else if (cmd === "ingest") {
      const parsed = parseIngestArgs(rest);
      if (!parsed.ok) return usageFail(stderr, parsed.message);
    } else if (cmd === "extend") {
      const parsed = parseExtendArgs(rest);
      if (!parsed.ok) return usageFail(stderr, parsed.message);
    } else if (cmd === "status") {
      const parsed = parseStatusArgs(rest);
      if (!parsed.ok) return usageFail(stderr, parsed.message);
    } else {
      const parsed = parseDeleteArgs(rest);
      if (!parsed.ok) return usageFail(stderr, parsed.message);
    }
    const client =
      deps.client ??
      clientFromConfig(cfg, {
        env,
        notify: (m) => stderr(`agentrag: ${m}\n`),
      });
    const io = { client, stdout, stderr };
    if (cmd === "ask") return await runAsk(rest, io);
    if (cmd === "ingest") return await runIngest(rest, io);
    if (cmd === "extend") return await runExtend(rest, io);
    if (cmd === "status") return await runStatus(rest, io);
    return await runDelete(rest, io);
  } catch (e) {
    return mapError(e, stderr);
  }
}

/** Print a usage error in the same shape mapError gives UsageError, and return EXIT.USAGE. */
function usageFail(stderr: Writer, message: string): number {
  printError(stderr, "usage", message);
  return EXIT.USAGE;
}

function mapError(e: unknown, stderr: Writer): number {
  if (e instanceof SpendCapError) {
    printError(stderr, e.code, e.message);
    return EXIT.PAYMENT;
  }
  if (e instanceof AgentRagError) {
    printError(stderr, e.code, e.message, e.hint);
    if (e.status === 404) return EXIT.NOT_FOUND;
    if (e.status === 402) return EXIT.PAYMENT;
    return EXIT.GENERIC;
  }
  // Bare AgentXError (not an AgentRagError): core's caller-side x402 pins throw these BEFORE any
  // signature — payto_mismatch / network_mismatch / asset_mismatch carry no HTTP status. A
  // payment pin failure is a payment problem (EXIT.PAYMENT); otherwise fall through to the
  // generic code.
  if (e instanceof AgentXError) {
    printError(stderr, e.code, e.message);
    if (e.status === 404) return EXIT.NOT_FOUND;
    if (e.status === 402) return EXIT.PAYMENT;
    if (e.code === "payto_mismatch" || e.code === "network_mismatch" || e.code === "asset_mismatch")
      return EXIT.PAYMENT;
    return EXIT.GENERIC;
  }
  if (e instanceof UsageError) {
    printError(stderr, "usage", e.message);
    return EXIT.USAGE;
  }
  printError(stderr, "error", e instanceof Error ? e.message : String(e));
  return EXIT.GENERIC;
}

function isMainModule(): boolean {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (isMainModule()) {
  runCli(process.argv.slice(2), {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
  }).then((code) => {
    process.exitCode = code;
  });
}
