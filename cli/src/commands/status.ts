import { parseFlags } from "../args";
import { EXIT, printError, printJson, type Writer } from "../output";

type StatusClient = {
  status: (collection: string) => Promise<unknown>;
};

export async function runStatus(
  args: string[],
  io: { client: StatusClient; stdout: Writer; stderr: Writer },
): Promise<number> {
  const { positionals } = parseFlags(args);
  const collection = positionals[0];
  if (!collection) {
    printError(io.stderr, "usage", "status requires <collection>");
    return EXIT.USAGE;
  }
  printJson(io.stdout, await io.client.status(collection));
  return EXIT.OK;
}
