import type { AskOptions } from "@agentrag/client";
import { ASK_FLAGS, parseFlags } from "../args";
import { EXIT, printError, printJson, type Writer } from "../output";

// Exported so tests can type a fake client against the exact shape the real AgentRag must
// satisfy, instead of erasing the seam with `as never`/`as any`.
export type AskClient = {
  ask: (query: string, o?: AskOptions) => Promise<unknown>;
  askAndWait: (query: string, o?: AskOptions) => Promise<unknown>;
};

/** The validated result of parseAskArgs: either ready-to-send args, or a usage-error message. */
export type AskArgs =
  | { ok: true; query: string; opts: AskOptions; wait: boolean }
  | { ok: false; message: string };

/**
 * Parse and fully validate `ask`'s own arguments — no client, no network. Split out of runAsk so
 * cli.ts can run this SAME check before constructing the client: clientFromConfig (config.ts)
 * mints and persists a wallet on first use, so a missing/invalid argument must never get that
 * far. parseFlags's own throws (unknown/disallowed flag, missing/malformed value) are
 * deliberately NOT caught here — they propagate exactly as before, straight to runCli's
 * mapError.
 */
export function parseAskArgs(args: string[]): AskArgs {
  const { flags, positionals } = parseFlags(args, ASK_FLAGS);
  const query = positionals[0];
  if (!query) return { ok: false, message: "ask requires <query>" };
  const f = flags as {
    sources?: string[];
    collection?: string;
    topK?: number;
    mode?: AskOptions["mode"];
    maxPages?: number;
    wait?: boolean;
  };
  return {
    ok: true,
    query,
    wait: !!f.wait,
    opts: {
      sources: f.sources,
      collection: f.collection,
      topK: f.topK,
      mode: f.mode,
      maxPages: f.maxPages,
    },
  };
}

export async function runAsk(
  args: string[],
  io: { client: AskClient; stdout: Writer; stderr: Writer },
): Promise<number> {
  const parsed = parseAskArgs(args);
  if (!parsed.ok) {
    printError(io.stderr, "usage", parsed.message);
    return EXIT.USAGE;
  }
  const result = parsed.wait
    ? await io.client.askAndWait(parsed.query, parsed.opts)
    : await io.client.ask(parsed.query, parsed.opts);
  printJson(io.stdout, result);
  return EXIT.OK;
}
