import type { AskOptions } from "@agentrag/client";
import { parseFlags } from "../args";
import { EXIT, printError, printJson, type Writer } from "../output";

type AskClient = {
  ask: (query: string, o?: AskOptions) => Promise<unknown>;
  askAndWait: (query: string, o?: AskOptions) => Promise<unknown>;
};

export async function runAsk(
  args: string[],
  io: { client: AskClient; stdout: Writer; stderr: Writer },
): Promise<number> {
  const { flags, positionals } = parseFlags(args);
  const query = positionals[0];
  if (!query) {
    printError(io.stderr, "usage", "ask requires <query>");
    return EXIT.USAGE;
  }
  const f = flags as {
    sources?: string[];
    collection?: string;
    topK?: number;
    mode?: AskOptions["mode"];
    maxPages?: number;
    wait?: boolean;
  };
  const opts: AskOptions = {
    sources: f.sources,
    collection: f.collection,
    topK: f.topK,
    mode: f.mode,
    maxPages: f.maxPages,
  };
  const result = f.wait
    ? await io.client.askAndWait(query, opts)
    : await io.client.ask(query, opts);
  printJson(io.stdout, result);
  return EXIT.OK;
}
