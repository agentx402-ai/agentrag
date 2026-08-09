import type {
  AskOptions,
  AskPending,
  AskResult,
  CollectionStatus,
  ExtendResult,
  IngestOptions,
  IngestResult,
  RagModelId,
} from "@agentrag/client";
import { MAX_PAGES_PER_CALL, MAX_TOP_K } from "@agentrag/client";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { isAccountMode, resolveWalletIdentity, type WalletIdentity } from "./commands/wallet";
import { clientFromConfig, readConfigFile, resolveConfig } from "./config";
import { scrubSensitiveEnv } from "./secrets";
import { VERSION } from "./version";

const text = (v: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(v) }],
});

/**
 * The exact subset of `AgentRag` the six tools below call. Exported so tests can type a fake
 * client against the shape the real class must satisfy, instead of erasing the seam with
 * `as never`/`as any` — same discipline as commands/ask.ts's AskClient / commands/ingest.ts's
 * IngestClient. `AgentRag` itself is structurally assignable here (its real methods are a
 * superset-compatible match), so `startMcp` passes the real client through with no cast.
 */
export type McpClient = {
  ask: (query: string, o?: AskOptions) => Promise<AskResult | AskPending>;
  askAndWait: (
    query: string,
    o?: AskOptions & { maxWaitMs?: number; pollIntervalMs?: number },
  ) => Promise<AskResult>;
  ingest: (o: IngestOptions) => Promise<IngestResult | AskPending>;
  ingestAndWait: (
    o?: IngestOptions & { maxWaitMs?: number; pollIntervalMs?: number },
  ) => Promise<IngestResult>;
  extend: (collection: string, days: 30 | 60 | 90) => Promise<ExtendResult>;
  status: (collection: string) => Promise<CollectionStatus>;
  delete: (collection: string) => Promise<{ deleted: true }>;
};

export function buildMcpServer(deps: { client: McpClient; wallet: WalletIdentity }): McpServer {
  const { client, wallet } = deps;
  const server = new McpServer({ name: "agentrag", version: VERSION });

  server.tool(
    "rag_ask",
    "Ask a question over your documents (hybrid BM25 + vector retrieval). If `sources` names " +
      "URLs the target collection hasn't indexed yet, this also ingests them first, on demand " +
      "(this tool has no `refresh` option — to force re-fetching an already-indexed source, " +
      "call rag_ingest with refresh:true first). SPENDS real USDC (x402 wallet mode) or credits " +
      "(account-key mode); honors maxSpendUsd/maxSessionSpendUsd. Flat $0.008/ask when no " +
      "ingest is needed; an on-demand ingest leg adds per-page pricing on top. A needed ingest " +
      "that takes a while resolves as a pending status (not an error) — set `wait:true` to " +
      "block until it finishes and get the real answer back in one call.",
    {
      query: z.string().describe("The question to ask"),
      sources: z
        .array(z.string().url())
        .optional()
        .describe(
          "Sources to ingest before answering, if the target collection doesn't exist yet. " +
            "Each an exact http(s) URL or a trailing '/**' same-origin crawl root. To force " +
            "re-ingesting an already-indexed source, use rag_ingest with refresh:true instead.",
        ),
      collection: z
        .string()
        .optional()
        .describe("Target an existing named collection instead of one derived from sources"),
      top_k: z
        .number()
        .int()
        .min(1)
        .max(MAX_TOP_K)
        .optional()
        .describe(`Number of chunks to retrieve (1-${MAX_TOP_K})`),
      mode: z.enum(["hybrid", "dense", "bm25"]).optional().describe("Retrieval mode"),
      max_pages: z
        .number()
        .int()
        .min(1)
        .max(MAX_PAGES_PER_CALL)
        .optional()
        .describe("Cap on pages ingested by this call, if an ingest is needed"),
      wait: z
        .boolean()
        .optional()
        .describe(
          "Block until any needed ingest finishes and return the real answer, instead of a pending status",
        ),
    },
    // Paid: a host must be free to prompt a human before this runs, so it is never read-only.
    // Not destructive: asking a question destroys nothing. destructiveHint DEFAULTS TO TRUE per
    // the MCP spec, so omitting it would advertise an untruthful "may perform destructive
    // updates" on a paid read. idempotentHint stays omitted (its default, false, is already
    // correct — each call is billed separately).
    {
      title: "Ask",
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
    async (a) => {
      const opts: AskOptions = {
        sources: a.sources,
        collection: a.collection,
        topK: a.top_k,
        mode: a.mode,
        maxPages: a.max_pages,
      };
      return text(
        a.wait ? await client.askAndWait(a.query, opts) : await client.ask(a.query, opts),
      );
    },
  );

  server.tool(
    "rag_ingest",
    "Explicitly ingest `sources` (URLs, or a trailing '/**' same-origin crawl root) and/or raw " +
      "`documents` (text with no URL) into a named collection — the only way to index documents " +
      "directly, or to force a `refresh` re-fetch. SPENDS real USDC/credits, per page/document " +
      "unit ($0.005/page); honors maxSpendUsd/maxSessionSpendUsd. A large source set needs a " +
      "durable job and resolves as a pending status (not an error); a small one resolves inline. " +
      "A job that takes a while resolves as a pending status — set `wait:true` to block until it " +
      "finishes and get the final page/chunk counts back in one call.",
    {
      sources: z
        .array(z.string().url())
        .optional()
        .describe(
          "URLs to ingest, or a trailing '/**' same-origin crawl root. Required unless `documents` is given.",
        ),
      documents: z
        .array(
          z.object({
            text: z.string(),
            title: z.string().optional(),
            url: z.string().optional(),
          }),
        )
        .optional()
        .describe("Raw text documents to index directly. Required unless `sources` is given."),
      collection: z.string().optional().describe("Name the collection; omit to derive one"),
      model: z
        .string()
        .optional()
        .describe(
          "Embedding model id. Fixed at collection creation — omit to inherit the target collection's own.",
        ),
      max_pages: z
        .number()
        .int()
        .min(1)
        .max(MAX_PAGES_PER_CALL)
        .optional()
        .describe("Cap on pages ingested by this call"),
      refresh: z
        .boolean()
        .optional()
        .describe("Force re-ingestion even if the collection already exists"),
      wait: z
        .boolean()
        .optional()
        .describe(
          "Block until the ingest job finishes and return the final result, instead of a pending status",
        ),
    },
    // Paid, and non-destructive for the same reason as rag_ask — see the note there.
    {
      title: "Ingest",
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
    async (a) => {
      const opts: IngestOptions = {
        sources: a.sources,
        documents: a.documents,
        collection: a.collection,
        model: a.model as RagModelId | undefined,
        maxPages: a.max_pages,
        refresh: a.refresh,
      };
      return text(a.wait ? await client.ingestAndWait(opts) : await client.ingest(opts));
    },
  );

  server.tool(
    "rag_extend",
    "Push a named collection's expiry out by 30/60/90 days. SPENDS real USDC/credits, priced on " +
      "the collection's REAL chunk count ($0.01 per 5,000-chunk block, times days/30); honors " +
      "maxSpendUsd/maxSessionSpendUsd.",
    {
      collection: z.string().describe("The collection to extend"),
      days: z
        .union([z.literal(30), z.literal(60), z.literal(90)])
        .describe("How many days to push the expiry out by — must be 30, 60, or 90"),
    },
    // Paid, and non-destructive for the same reason as rag_ask — see the note there.
    {
      title: "Extend",
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
    async (a) => text(await client.extend(a.collection, a.days)),
  );

  server.tool(
    "rag_status",
    "Read a collection's metadata: embedding model, page/chunk counts, creation/expiry " +
      "timestamps, and any in-flight ingest job's state. Free, owner-gated (identity-signed or " +
      "bearer).",
    { collection: z.string().describe("The collection to inspect") },
    { title: "Collection status", readOnlyHint: true, openWorldHint: true },
    async (a) => text(await client.status(a.collection)),
  );

  server.tool(
    "rag_delete",
    "Immediately and permanently delete an owned collection — there is no undo. Free, " +
      "owner-gated (identity-signed or bearer).",
    { collection: z.string().describe("The collection to delete") },
    // Free, but genuinely destructive — the ONE tool in this surface where destructiveHint:true
    // is the truthful annotation (contrast rag_ask/ingest/extend, which spend money but destroy
    // nothing, and default-true would misrepresent THEM instead).
    {
      title: "Delete collection",
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    },
    async (a) => text(await client.delete(a.collection)),
  );

  server.tool(
    "rag_wallet_address",
    "Return the address AgentRAG pays from, plus the local keystore file backing it. Free and " +
      "purely local — no network call, no spend. AgentRAG mints this wallet on first use, so " +
      "this is how to find the address to FUND with USDC on Base and the file to back up. Never " +
      "returns the private key.",
    {},
    // Free, local, and reads nothing but already-resolved local state: read-only, closed-world.
    { title: "Wallet address", readOnlyHint: true, openWorldHint: false },
    // `wallet` is a plain value captured at startup — the private key is never in scope here.
    async () => text(wallet),
  );

  return server;
}

/**
 * Everything `startMcp` does BEFORE touching stdio: resolve config, warn on stderr if unbounded,
 * build the client, resolve the wallet identity, and scrub the sensitive env — in that exact
 * load-bearing order (see `startMcp`'s own doc comment for why). Split out from `startMcp` so a
 * test can drive this half directly and assert the scrub genuinely ran against the given `env`
 * object, without going through a real `StdioServerTransport.connect()` — which spawns a real
 * read loop against THIS process's actual stdin/stdout and would corrupt the test runner's own
 * I/O, not just the imagined MCP server's.
 *
 * Review fix round 1 (Important #3): before this split, `scrubSensitiveEnv(deps.env)` in
 * `startMcp` had no direct coverage — deleting that one call site left the full suite green,
 * because every test that exercised `startMcp` end to end had to go through the built binary
 * (which can't safely be re-run per line of setup), and every test of `scrubSensitiveEnv` itself
 * called the function directly rather than through `startMcp`'s own call site.
 */
export function prepareMcp(deps: { env: NodeJS.ProcessEnv; stderr: (s: string) => void }): {
  server: McpServer;
  wallet: WalletIdentity;
} {
  const cfg = resolveConfig({}, deps.env, () => readConfigFile(deps.env));
  // Visibility, not a default cap: an MCP server lives for a whole session and every paid verb
  // spends, so without a cumulative bound the total is unbounded no matter what the per-op cap
  // is. Say so once, on stderr (stdout is the JSON-RPC channel), rather than changing spend
  // behavior.
  if (cfg.maxSessionSpendUsd === undefined) {
    deps.stderr(
      "agentrag mcp: no session spend cap configured — this server can spend without a " +
        "cumulative bound. Set AGENTRAG_MAX_SESSION_SPEND_USD (and AGENTRAG_MAX_SPEND_USD) to bound it.\n",
    );
  }
  const accountMode = isAccountMode(deps.env);
  const client = clientFromConfig(cfg, {
    env: deps.env,
    notify: (m) => deps.stderr(`agentrag: ${m}\n`),
  });
  // Resolve the paying wallet AFTER clientFromConfig (which mints one on first use, so there is
  // an address to report) but BEFORE scrubSensitiveEnv drops AGENTRAG_PRIVATE_KEY — once
  // scrubbed, this would fall through to the keystore and report an address the client never
  // pays from.
  const wallet = resolveWalletIdentity(deps.env, accountMode);
  scrubSensitiveEnv(deps.env);
  const server = buildMcpServer({ client, wallet });
  return { server, wallet };
}

export async function startMcp(deps: {
  env: NodeJS.ProcessEnv;
  stderr: (s: string) => void;
}): Promise<number> {
  const { server } = prepareMcp(deps);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Keep the process alive until the MCP session genuinely closes. Authoritative signal: the
  // SDK server's own onclose hook. Belt-and-suspenders: stdin EOF/close as a fallback (an MCP
  // host that closes our stdin without a clean transport close still lets us exit). resolve is
  // idempotent, so both signals firing is harmless.
  await new Promise<void>((resolve) => {
    server.server.onclose = () => resolve();
    process.stdin.once("close", resolve);
    process.stdin.once("end", resolve);
  });
  return 0;
}
