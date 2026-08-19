import { EXTEND_FLAGS, extraPositionalError, parseFlags } from "../args";
import { EXIT, printError, printJson, type Writer } from "../output";

// Exported so tests can type a fake client against the exact shape the real AgentRag must
// satisfy, instead of erasing the seam with `as never`/`as any`.
export type ExtendClient = {
  extend: (collection: string, days: 30 | 60 | 90) => Promise<unknown>;
};

function isExtendDays(n: number): n is 30 | 60 | 90 {
  return n === 30 || n === 60 || n === 90;
}

/** The validated result of parseExtendArgs: either ready-to-send args, or a usage-error message. */
export type ExtendArgs =
  | { ok: true; collection: string; days: 30 | 60 | 90 }
  | { ok: false; message: string };

/**
 * Parse and validate `extend`'s own arguments — no client, no network. See parseAskArgs's doc
 * comment (commands/ask.ts) for why this is split out: cli.ts runs it before clientFromConfig,
 * which mints a wallet on first use. extend has THREE distinct usage-error gates (missing
 * collection, missing --days, and an out-of-range --days) — all three must clear before any
 * client exists.
 */
export function parseExtendArgs(args: string[]): ExtendArgs {
  const { flags, positionals } = parseFlags(args, EXTEND_FLAGS);
  const collection = positionals[0];
  if (!collection) return { ok: false, message: "extend requires <collection>" };
  const extra = extraPositionalError(positionals, "extend", "collection");
  if (extra) return { ok: false, message: extra };
  const f = flags as { days?: number };
  if (f.days === undefined) return { ok: false, message: "extend requires --days 30|60|90" };
  if (!isExtendDays(f.days)) {
    return {
      ok: false,
      message: `--days must be one of 30, 60, 90 (got ${f.days})`,
    };
  }
  return { ok: true, collection, days: f.days };
}

export async function runExtend(
  args: string[],
  io: { client: ExtendClient; stdout: Writer; stderr: Writer },
): Promise<number> {
  const parsed = parseExtendArgs(args);
  if (!parsed.ok) {
    printError(io.stderr, "usage", parsed.message);
    return EXIT.USAGE;
  }
  const result = await io.client.extend(parsed.collection, parsed.days);
  printJson(io.stdout, result);
  return EXIT.OK;
}
