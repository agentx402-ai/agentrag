import { readFileSync } from "node:fs";
import type { IngestDocument, IngestOptions } from "@agentrag/client";
import { INGEST_FLAGS, parseFlags, UsageError } from "../args";
import { EXIT, printError, printJson, type Writer } from "../output";

// Exported so tests can type a fake client against the exact shape the real AgentRag must
// satisfy, instead of erasing the seam with `as never`/`as any`.
export type IngestClient = {
  ingest: (o: IngestOptions) => Promise<unknown>;
  ingestAndWait: (o?: IngestOptions) => Promise<unknown>;
};

/**
 * Load `--documents FILE`: a JSON file containing an array of `{text, title?, url?}` objects
 * (the SDK's own IngestDocument shape). Deeper validation (text is a string, size limits) is
 * left to the client (assertValidDocuments), which runs before any network call either way —
 * this only needs to fail loud on "not a file", "not JSON", and "not an array" so a typo'd
 * path is a clean usage error rather than a raw fs/JSON exception.
 */
function loadDocuments(path: string): IngestDocument[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new UsageError(
      `--documents file ${path} could not be read: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new UsageError(`--documents file ${path} is not valid JSON`);
  }
  if (!Array.isArray(parsed)) {
    throw new UsageError(`--documents file ${path} must contain a JSON array of documents`);
  }
  return parsed as IngestDocument[];
}

/** The validated result of parseIngestArgs: either ready-to-send opts, or a usage-error message. */
export type IngestArgs =
  | { ok: true; opts: IngestOptions; wait: boolean }
  | { ok: false; message: string };

/**
 * Parse and validate `ingest`'s own arguments — no client, no network. See parseAskArgs's doc
 * comment (commands/ask.ts) for why this is split out: cli.ts runs it before clientFromConfig,
 * which mints a wallet on first use. ingest has no required positional, but a bad --documents
 * file (missing, invalid JSON, or not an array) is the same class of usage error and must clear
 * before a client is ever built.
 */
export function parseIngestArgs(args: string[]): IngestArgs {
  const { flags } = parseFlags(args, INGEST_FLAGS);
  const f = flags as {
    sources?: string[];
    documents?: string;
    collection?: string;
    model?: IngestOptions["model"];
    maxPages?: number;
    refresh?: boolean;
    wait?: boolean;
  };
  let documents: IngestDocument[] | undefined;
  if (f.documents !== undefined) {
    try {
      documents = loadDocuments(f.documents);
    } catch (e) {
      if (e instanceof UsageError) return { ok: false, message: e.message };
      throw e;
    }
  }
  return {
    ok: true,
    wait: !!f.wait,
    opts: {
      sources: f.sources,
      documents,
      collection: f.collection,
      model: f.model,
      maxPages: f.maxPages,
      refresh: f.refresh,
    },
  };
}

export async function runIngest(
  args: string[],
  io: { client: IngestClient; stdout: Writer; stderr: Writer },
): Promise<number> {
  const parsed = parseIngestArgs(args);
  if (!parsed.ok) {
    printError(io.stderr, "usage", parsed.message);
    return EXIT.USAGE;
  }
  const result = parsed.wait
    ? await io.client.ingestAndWait(parsed.opts)
    : await io.client.ingest(parsed.opts);
  printJson(io.stdout, result);
  return EXIT.OK;
}
