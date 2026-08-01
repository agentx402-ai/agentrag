import { EXTEND_FLAGS, parseFlags } from "../args";
import { EXIT, printError, printJson, type Writer } from "../output";

// Exported so tests can type a fake client against the exact shape the real AgentRag must
// satisfy, instead of erasing the seam with `as never`/`as any`.
export type ExtendClient = {
  extend: (collection: string, days: 30 | 60 | 90) => Promise<unknown>;
};

function isExtendDays(n: number): n is 30 | 60 | 90 {
  return n === 30 || n === 60 || n === 90;
}

export async function runExtend(
  args: string[],
  io: { client: ExtendClient; stdout: Writer; stderr: Writer },
): Promise<number> {
  const { flags, positionals } = parseFlags(args, EXTEND_FLAGS);
  const collection = positionals[0];
  if (!collection) {
    printError(io.stderr, "usage", "extend requires <collection>");
    return EXIT.USAGE;
  }
  const f = flags as { days?: number };
  if (f.days === undefined) {
    printError(io.stderr, "usage", "extend requires --days 30|60|90");
    return EXIT.USAGE;
  }
  if (!isExtendDays(f.days)) {
    printError(io.stderr, "usage", `--days must be one of 30, 60, 90 (got ${f.days})`);
    return EXIT.USAGE;
  }
  const result = await io.client.extend(collection, f.days);
  printJson(io.stdout, result);
  return EXIT.OK;
}
