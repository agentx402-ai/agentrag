import { parseFlags } from "../args";
import { EXIT, printError, printJson, type Writer } from "../output";

type DeleteClient = {
  delete: (collection: string) => Promise<unknown>;
};

export async function runDelete(
  args: string[],
  io: { client: DeleteClient; stdout: Writer; stderr: Writer },
): Promise<number> {
  const { positionals } = parseFlags(args);
  const collection = positionals[0];
  if (!collection) {
    printError(io.stderr, "usage", "delete requires <collection>");
    return EXIT.USAGE;
  }
  printJson(io.stdout, await io.client.delete(collection));
  return EXIT.OK;
}
