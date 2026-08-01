import { parseFlags, STATUS_FLAGS } from "../args";
import { EXIT, printError, printJson, type Writer } from "../output";

// Exported so tests can type a fake client against the exact shape the real AgentRag must
// satisfy, instead of erasing the seam with `as never`/`as any`.
export type StatusClient = {
  status: (collection: string) => Promise<unknown>;
};

export async function runStatus(
  args: string[],
  io: { client: StatusClient; stdout: Writer; stderr: Writer },
): Promise<number> {
  const { positionals } = parseFlags(args, STATUS_FLAGS);
  const collection = positionals[0];
  if (!collection) {
    printError(io.stderr, "usage", "status requires <collection>");
    return EXIT.USAGE;
  }
  printJson(io.stdout, await io.client.status(collection));
  return EXIT.OK;
}
