import { DELETE_FLAGS, extraPositionalError, parseFlags } from "../args";
import { EXIT, printError, printJson, type Writer } from "../output";

// Exported so tests can type a fake client against the exact shape the real AgentRag must
// satisfy, instead of erasing the seam with `as never`/`as any`.
export type DeleteClient = {
  delete: (collection: string) => Promise<unknown>;
};

/** The validated result of parseDeleteArgs: either the collection, or a usage-error message. */
export type DeleteArgs = { ok: true; collection: string } | { ok: false; message: string };

/**
 * Parse and validate `delete`'s own arguments — no client, no network. See parseAskArgs's doc
 * comment (commands/ask.ts) for why this is split out: cli.ts runs it before clientFromConfig,
 * which mints a wallet on first use.
 */
export function parseDeleteArgs(args: string[]): DeleteArgs {
  const { positionals } = parseFlags(args, DELETE_FLAGS);
  const collection = positionals[0];
  if (!collection) return { ok: false, message: "delete requires <collection>" };
  const extra = extraPositionalError(positionals, "delete", "collection");
  if (extra) return { ok: false, message: extra };
  return { ok: true, collection };
}

export async function runDelete(
  args: string[],
  io: { client: DeleteClient; stdout: Writer; stderr: Writer },
): Promise<number> {
  const parsed = parseDeleteArgs(args);
  if (!parsed.ok) {
    printError(io.stderr, "usage", parsed.message);
    return EXIT.USAGE;
  }
  printJson(io.stdout, await io.client.delete(parsed.collection));
  return EXIT.OK;
}
