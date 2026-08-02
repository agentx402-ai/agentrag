import { AgentRag, SpendCapError } from "@agentrag/client";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import type { WalletIdentity } from "../src/commands/wallet";
import { buildMcpServer, type McpClient, prepareMcp } from "../src/mcp";

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

  // Review fix round 1 (Important #1): rag_ask's description used to claim a `refresh` flag it
  // never accepted — a model reading the description would set `refresh:true` expecting a
  // forced re-fetch, get a confident 200 computed from the stale index, and be billed for it,
  // with nothing reporting the flag was dropped. The description is now corrected to say rag_ask
  // has no refresh option; these two tests pin that the CODE actually matches that claim, so a
  // future change that starts wiring `refresh` through without also updating the description (or
  // vice versa) is caught.
  it("rag_ask's schema has no refresh field — an extra refresh:true is stripped from the parsed input", () => {
    const t = tools(fakeClient());
    const result = t.rag_ask.inputSchema.safeParse({
      query: "q",
      collection: "docs",
      refresh: true,
    });
    expect(result.success).toBe(true);
    expect((result as unknown as { data: Record<string, unknown> }).data).not.toHaveProperty(
      "refresh",
    );
  });

  it("rag_ask never forwards refresh to client.ask, even when the caller passes one", async () => {
    const seen: Record<string, unknown> = {};
    await tools(fakeClient(seen)).rag_ask.handler(
      { query: "what is x?", collection: "docs", refresh: true },
      {},
    );
    expect(seen.ask).not.toHaveProperty("refresh");
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

// Review fix round 1 (Important #4): the test above drives `refusingClient()`, whose `ask`
// throws SpendCapError unconditionally — that proves the handler doesn't SWALLOW a throw
// (trivially true; it has no try/catch), but says nothing about whether a cap configured
// through AGENTRAG_MAX_SPEND_USD / AGENTRAG_MAX_SESSION_SPEND_USD actually reaches the REAL
// AgentRag the MCP path constructs. These drive a REAL AgentRag (the exact class
// clientFromConfig builds) through rag_ask's handler, with a fake HTTP layer standing in for
// the network, proving the real ceiling/session-cap machinery (performOp ->
// assertOpPriceCeiling / assertAndReserveSpend) refuses BEFORE any EIP-3009 signature is
// produced — the same probe the review ran independently against the built binary, committed
// here as a permanent regression instead of a one-off.
describe("rag_ask + a REAL AgentRag client: spend caps refuse before any signature", () => {
  const REAL_ENDPOINT = "https://rag.example";

  // Mirrors client/test/spend-caps.test.ts's own challenge() fixture exactly — the same
  // PAYMENT-REQUIRED shape the worker actually sends on a 402.
  function challenge(amount: string): string {
    return btoa(
      JSON.stringify({
        x402Version: 2,
        accepts: [
          {
            scheme: "exact",
            network: "eip155:8453",
            amount,
            asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            payTo: "0x0000000000000000000000000000000000000001",
            resource: "/v1/rag/ask",
            description: "/v1/rag/ask",
            mimeType: "application/json",
            maxTimeoutSeconds: 300,
          },
        ],
      }),
    );
  }

  // A bare probe always sees a 402 quoting exactly $0.008 (ASK_BASE_USD, so the authorized-
  // ceiling check passes and the SEPARATE, downstream spend-cap check is what's on trial).
  // Counts requests that actually CARRY a PAYMENT-SIGNATURE, so a test can assert "no
  // signature was ever produced/sent", not merely "the call rejected".
  function fetchQuoting8000(signed: { n: number }): typeof fetch {
    return (async (_url: unknown, init?: RequestInit) => {
      if (init?.headers && new Headers(init.headers).get("PAYMENT-SIGNATURE")) signed.n++;
      return new Response("{}", {
        status: 402,
        headers: { "PAYMENT-REQUIRED": challenge("8000") },
      });
    }) as unknown as typeof fetch;
  }

  it("a per-call maxSpendUsd below the real quote refuses before signing", async () => {
    const signed = { n: 0 };
    const realClient = new AgentRag({
      endpoint: REAL_ENDPOINT,
      signer: privateKeyToAccount(generatePrivateKey()),
      fetchImpl: fetchQuoting8000(signed),
      maxSpendUsd: 0.001, // below the real $0.008 ask price
    });
    const t = tools(realClient);
    const err = await t.rag_ask
      .handler({ query: "what is x?", collection: "docs" }, {})
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpendCapError);
    expect(signed.n).toBe(0);
  });

  it("a cumulative maxSessionSpendUsd below the real quote also refuses before signing", async () => {
    const signed = { n: 0 };
    const realClient = new AgentRag({
      endpoint: REAL_ENDPOINT,
      signer: privateKeyToAccount(generatePrivateKey()),
      fetchImpl: fetchQuoting8000(signed),
      maxSessionSpendUsd: 0.001, // below the real $0.008 ask price
    });
    const t = tools(realClient);
    const err = await t.rag_ask
      .handler({ query: "what is x?", collection: "docs" }, {})
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpendCapError);
    expect(signed.n).toBe(0);
  });

  it("baseline: with NO cap configured, the real client signs and succeeds (the probe above is not vacuous)", async () => {
    const signed = { n: 0 };
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      if (init?.headers && new Headers(init.headers).get("PAYMENT-SIGNATURE")) {
        signed.n++;
        return new Response(
          JSON.stringify({
            data: { collection: "docs", matched: true, chunks: [] },
          }),
          { status: 200 },
        );
      }
      return new Response("{}", {
        status: 402,
        headers: { "PAYMENT-REQUIRED": challenge("8000") },
      });
    }) as unknown as typeof fetch;
    const realClient = new AgentRag({
      endpoint: REAL_ENDPOINT,
      signer: privateKeyToAccount(generatePrivateKey()),
      fetchImpl,
    });
    const t = tools(realClient);
    const res = (await t.rag_ask.handler({ query: "what is x?", collection: "docs" }, {})) as {
      content: Array<{ text: string }>;
    };
    expect(JSON.parse(res.content[0].text).matched).toBe(true);
    expect(signed.n).toBe(1);
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

// Review fix round 1 (Important #3): scrubSensitiveEnv(deps.env) in startMcp had NO direct
// coverage of the call site itself — deleting that one line left the full suite green, because
// every existing test either called scrubSensitiveEnv directly (proving the function works, not
// that startMcp calls it) or drove startMcp only through the built binary's own stdio (which
// can't observe the child's live process.env from outside). prepareMcp (mcp.ts) exists so this
// can be tested directly: it's everything startMcp does up to and including the scrub, minus the
// real stdio connect, which would fight over this test process's own stdin/stdout.
describe("prepareMcp: the sensitive env is genuinely scrubbed at the real call site", () => {
  const DUMMY_KEY = `0x${"1".repeat(64)}` as `0x${string}`;

  it("AGENTRAG_PRIVATE_KEY is gone from the given env object after prepareMcp returns", () => {
    const env: NodeJS.ProcessEnv = {
      AGENTRAG_PRIVATE_KEY: DUMMY_KEY,
      AGENTRAG_ENDPOINT: "https://rag.example",
    };
    const { wallet } = prepareMcp({ env, stderr: () => {} });
    // Sanity: wallet resolution ran BEFORE the scrub, using the (now-gone) env key — proves this
    // test actually exercised the env-key path, not e.g. an accidental keystore fallback that
    // would pass even with the scrub call deleted.
    expect(wallet.source).toBe("env");
    expect(wallet.address).toBe(privateKeyToAccount(DUMMY_KEY).address);
    expect(env.AGENTRAG_PRIVATE_KEY).toBeUndefined();
  });

  it("AGENTRAG_ACCOUNT_KEY is gone from the given env object after prepareMcp returns", () => {
    const env: NodeJS.ProcessEnv = {
      AGENTRAG_ACCOUNT_KEY: `ak_${"9".repeat(64)}`,
      AGENTRAG_ENDPOINT: "https://rag.example",
    };
    const { wallet } = prepareMcp({ env, stderr: () => {} });
    expect(wallet.source).toBe("account-key");
    expect(env.AGENTRAG_ACCOUNT_KEY).toBeUndefined();
  });

  it("an unrelated env var is left untouched", () => {
    const env: NodeJS.ProcessEnv = {
      AGENTRAG_PRIVATE_KEY: DUMMY_KEY,
      AGENTRAG_ENDPOINT: "https://rag.example",
    };
    prepareMcp({ env, stderr: () => {} });
    expect(env.AGENTRAG_ENDPOINT).toBe("https://rag.example");
  });
});
