import { DELETE_FLAGS, parseFlags } from "../args";
import { EXIT, printError, printJson, type Writer } from "../output";

// Exported so tests can type a fake client against the exact shape the real AgentRag must
// satisfy, instead of erasing the seam with `as never`/`as any`.
export type DeleteClient = {
  delete: (collection: string) => Promise<unknown>;
};

export async function runDelete(
  args: string[],
  io: { client: DeleteClient; stdout: Writer; stderr: Writer },
): Promise<number> {
  const { positionals } = parseFlags(args, DELETE_FLAGS);
  const collection = positionals[0];
  if (!collection) {
    printError(io.stderr, "usage", "delete requires <collection>");
    return EXIT.USAGE;
  }
  printJson(io.stdout, await io.client.delete(collection));
  return EXIT.OK;
}
