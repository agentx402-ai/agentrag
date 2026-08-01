import { SpendCapError } from "@agentrag/client";
import { describe, expect, it } from "vitest";
import type { WalletIdentity } from "../src/commands/wallet";
import { buildMcpServer, type McpClient } from "../src/mcp";

// Complete, real-shaped fixtures (not minimal partials) — same discipline as cli.test.ts's
// verb-dispatch fixtures, so a fake that drifts from the real result shape fails typecheck.
const ASK_RESULT = {
  collection: "docs",
  expires_at: "2027-01-01T00:00:00.000Z",
  matched: true,
  chunks: [],
  settledTxHash: "",
};
const INGEST_RESULT = {
  collection: "docs",
  status: "complete",
  pages_total: 1,
  pages_failed: 0,
  chunks: 3,
  expires_at: "2027-01-01T00:00:00.000Z",
  settledTxHash: "",
};
const EXTEND_RESULT = {
  collection: "docs",
  expires_at: "2027-04-01T00:00:00.000Z",
  settledTxHash: "",
};
const STATUS_RESULT = {
  collection: "docs",
  model: "@cf/baai/bge-m3",
  pages: 1,
  chunks: 3,
  created_at: "2026-01-01T00:00:00.000Z",
  expires_at: "2027-01-01T00:00:00.000Z",
};

/** Records the args each verb was called with, so a call can be asserted precisely. */
function fakeClient(seen: Record<string, unknown> = {}): McpClient {
  return {
    ask: async (query, o) => {
      seen.ask = { query, ...o };
      return ASK_RESULT;
    },
    askAndWait: async (query, o) => {
      seen.askAndWait = { query, ...o };
      return ASK_RESULT;
    },
    ingest: async (o) => {
      seen.ingest = o;
      return INGEST_RESULT;
    },
    extend: async (collection, days) => {
      seen.extend = { collection, days };
      return EXTEND_RESULT;
    },
    status: async (collection) => {
      seen.status = { collection };
      return STATUS_RESULT;
    },
    delete: async (collection) => {
      seen.delete = { collection };
      return { deleted: true as const };
    },
  };
}

/** A client whose paid `ask` refuses (SpendCapError) — models a server-quote over maxSpendUsd. */
function refusingClient(): McpClient {
  return {
    ...fakeClient(),
    ask: async () => {
      throw new SpendCapError("server quoted $1 but the client only authorized $0.008");
    },
  };
}

const WALLET: WalletIdentity = {
  address: `0x${"ab".repeat(20)}`,
  source: "keystore",
  path: "/tmp/agentrag-test/wallet.json",
};

function tools(client: McpClient, wallet: WalletIdentity = WALLET) {
  const server = buildMcpServer({ client, wallet });
  // _registeredTools is McpServer's own internal registry (not part of its public API) — the
  // only way to introspect what tool() actually registered without going through a live
  // transport. A single `as any` (not `as unknown as`) reaches it; the following `as Record<...>`
  // narrows the shape back down for ergonomic assertions below.
  return (server as any)._registeredTools as Record<
    string,
    {
      annotations?: Record<string, unknown>;
      inputSchema: { safeParse: (v: unknown) => { success: boolean } };
      handler: (a: unknown, e: unknown) => Promise<unknown>;
    }
  >;
}

const PAID = ["rag_ask", "rag_ingest", "rag_extend"] as const;

describe("agentrag mcp tools", () => {
  it("registers the six rag tools", () => {
    expect(Object.keys(tools(fakeClient())).sort()).toEqual([
      "rag_ask",
      "rag_delete",
      "rag_extend",
      "rag_ingest",
      "rag_status",
      "rag_wallet_address",
    ]);
  });

  // The full annotation set, pinned. These are the hints a host uses to decide whether to prompt
  // a human, so an untruthful one is a real bug: `destructiveHint` DEFAULTS TO TRUE per the MCP
  // spec, so every paid tool must set it explicitly to `false` — EXCEPT rag_delete, which is
  // free but genuinely destructive and correctly carries `destructiveHint: true`.
  it("every tool advertises exactly the intended annotations", () => {
    const t = tools(fakeClient());
    expect(t.rag_ask.annotations).toEqual({
      title: "Ask",
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    });
    expect(t.rag_ingest.annotations).toEqual({
      title: "Ingest",
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    });
    expect(t.rag_extend.annotations).toEqual({
      title: "Extend",
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    });
    expect(t.rag_status.annotations).toEqual({
      title: "Collection status",
      readOnlyHint: true,
      openWorldHint: true,
    });
    expect(t.rag_delete.annotations).toEqual({
      title: "Delete collection",
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    });
    expect(t.rag_wallet_address.annotations).toEqual({
      title: "Wallet address",
      readOnlyHint: true,
      openWorldHint: false,
    });
  });

  it("every paid verb is never advertised as read-only, and explicitly never as destructive", () => {
    const t = tools(fakeClient());
    for (const name of PAID) {
      expect(t[name].annotations?.readOnlyHint).toBe(false);
      expect(t[name].annotations?.destructiveHint).toBe(false);
      // Omitted, not false: the MCP default (false) is already the truthful value.
      expect(t[name].annotations).not.toHaveProperty("idempotentHint");
    }
  });

  it("rag_delete is the one tool where destructiveHint:true is correct", () => {
    expect(tools(fakeClient()).rag_delete.annotations?.destructiveHint).toBe(true);
  });

  it("rag_ask calls client.ask by default and returns text content", async () => {
    const seen: Record<string, unknown> = {};
    const res = (await tools(fakeClient(seen)).rag_ask.handler(
      { query: "what is x?", collection: "docs" },
      {},
    )) as { content: Array<{ text: string }> };
    expect(JSON.parse(res.content[0].text).matched).toBe(true);
    expect(seen.askAndWait).toBeUndefined();
    expect((seen.ask as Record<string, unknown>).query).toBe("what is x?");
  });

  it("rag_ask calls client.askAndWait when wait:true", async () => {
    const seen: Record<string, unknown> = {};
    await tools(fakeClient(seen)).rag_ask.handler(
      { query: "what is x?", collection: "docs", wait: true },
      {},
    );
    expect(seen.ask).toBeUndefined();
    expect((seen.askAndWait as Record<string, unknown>).query).toBe("what is x?");
  });

  it("rag_ingest forwards its options to client.ingest", async () => {
    const seen: Record<string, unknown> = {};
    await tools(fakeClient(seen)).rag_ingest.handler(
      { sources: ["https://ex.com/**"], model: "@cf/baai/bge-m3" },
      {},
    );
    expect(seen.ingest).toMatchObject({
      sources: ["https://ex.com/**"],
      model: "@cf/baai/bge-m3",
    });
  });

  it("rag_extend forwards collection + days to client.extend", async () => {
    const seen: Record<string, unknown> = {};
    await tools(fakeClient(seen)).rag_extend.handler({ collection: "docs", days: 30 }, {});
    expect(seen.extend).toEqual({ collection: "docs", days: 30 });
  });

  it("rag_status and rag_delete forward the collection name", async () => {
    const seen: Record<string, unknown> = {};
    const t = tools(fakeClient(seen));
    await t.rag_status.handler({ collection: "docs" }, {});
    await t.rag_delete.handler({ collection: "docs" }, {});
    expect(seen.status).toEqual({ collection: "docs" });
    expect(seen.delete).toEqual({ collection: "docs" });
  });

  it("zod input validation: rag_ask rejects top_k 0 and accepts an in-range value", () => {
    const t = tools(fakeClient());
    expect(t.rag_ask.inputSchema.safeParse({ query: "q", top_k: 0 }).success).toBe(false);
    expect(t.rag_ask.inputSchema.safeParse({ query: "q", top_k: 5 }).success).toBe(true);
  });

  it("zod input validation: rag_ask rejects a non-URL source", () => {
    const t = tools(fakeClient());
    expect(t.rag_ask.inputSchema.safeParse({ query: "q", sources: ["not-a-url"] }).success).toBe(
      false,
    );
  });

  it("zod input validation: rag_extend rejects days:45 and accepts 30/60/90", () => {
    const t = tools(fakeClient());
    expect(t.rag_extend.inputSchema.safeParse({ collection: "docs", days: 45 }).success).toBe(
      false,
    );
    for (const days of [30, 60, 90]) {
      expect(t.rag_extend.inputSchema.safeParse({ collection: "docs", days }).success).toBe(true);
    }
  });

  it("a paid tool surfaces the client's spend refusal (does NOT return a success envelope)", async () => {
    const t = tools(refusingClient());
    // The handler awaits client.ask; a SpendCapError propagates rather than resolving to content.
    await expect(
      t.rag_ask.handler({ query: "what is x?", collection: "docs" }, {}),
    ).rejects.toBeInstanceOf(SpendCapError);
  });
});

describe("rag_wallet_address", () => {
  it("reports the resolved wallet address and keystore path", async () => {
    const res = (await tools(fakeClient()).rag_wallet_address.handler({}, {})) as {
      content: Array<{ text: string }>;
    };
    expect(JSON.parse(res.content[0].text)).toEqual(WALLET);
  });

  it("never exposes key material, whatever the caller passes", async () => {
    // The tool closes over a WalletIdentity, which has no private-key field at all — pin that
    // the serialized payload carries only address/source/path (never print a key).
    const res = (await tools(fakeClient()).rag_wallet_address.handler({}, {})) as {
      content: Array<{ text: string }>;
    };
    expect(Object.keys(JSON.parse(res.content[0].text)).sort()).toEqual([
      "address",
      "path",
      "source",
    ]);
    expect(res.content[0].text).not.toMatch(/privateKey|0x[0-9a-f]{64}/i);
  });

  it("reports account-key mode rather than a wallet address", async () => {
    const wallet: WalletIdentity = {
      address: null,
      source: "account-key",
      note: "no wallet in account-key mode",
    };
    const res = (await tools(fakeClient(), wallet).rag_wallet_address.handler({}, {})) as {
      content: Array<{ text: string }>;
    };
    expect(JSON.parse(res.content[0].text)).toEqual(wallet);
  });
});
