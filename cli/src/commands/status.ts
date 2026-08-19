import { extraPositionalError, parseFlags, STATUS_FLAGS } from "../args";
import { EXIT, printError, printJson, type Writer } from "../output";

// Exported so tests can type a fake client against the exact shape the real AgentRag must
// satisfy, instead of erasing the seam with `as never`/`as any`.
export type StatusClient = {
  status: (collection: string) => Promise<unknown>;
};

/** The validated result of parseStatusArgs: either the collection, or a usage-error message. */
export type StatusArgs = { ok: true; collection: string } | { ok: false; message: string };

/**
 * Parse and validate `status`'s own arguments — no client, no network. See parseAskArgs's doc
 * comment (commands/ask.ts) for why this is split out: cli.ts runs it before clientFromConfig,
 * which mints a wallet on first use.
 */
export function parseStatusArgs(args: string[]): StatusArgs {
  const { positionals } = parseFlags(args, STATUS_FLAGS);
  const collection = positionals[0];
  if (!collection) return { ok: false, message: "status requires <collection>" };
  const extra = extraPositionalError(positionals, "status", "collection");
  if (extra) return { ok: false, message: extra };
  return { ok: true, collection };
}

export async function runStatus(
  args: string[],
  io: { client: StatusClient; stdout: Writer; stderr: Writer },
): Promise<number> {
  const parsed = parseStatusArgs(args);
  if (!parsed.ok) {
    printError(io.stderr, "usage", parsed.message);
    return EXIT.USAGE;
  }
  printJson(io.stdout, await io.client.status(parsed.collection));
  return EXIT.OK;
}
