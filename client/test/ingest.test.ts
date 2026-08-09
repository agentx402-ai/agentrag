import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import { AgentRag, RAG_MODELS, SpendCapError } from "../src/index";
import { ingestAuthorizedCeilingUsd, usdToAtomic } from "../src/pricing";
import type { RagModelId } from "../src/types";

// Every 200/202 fixture in this file mirrors the REAL wire envelope
// (`{ data, request_id, usage? }`), not the SDK's own flattened result types — same
// discipline as ask.test.ts's own file header (verified against the worker's own test
// suite, which asserts `body.data.*` throughout).

const endpoint = "https://rag.example";
const signer = privateKeyToAccount(generatePrivateKey());
const AK = `ak_${"a".repeat(64)}`;

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
          resource: "/v1/rag/ingest",
          description: "ingest",
          mimeType: "application/json",
          maxTimeoutSeconds: 300,
        },
      ],
    }),
  );
}

/** A worker-shaped ingest 200/202 envelope: `{data: {...}, usage?, request_id?}`. */
function ingestEnvelope(
  data: Record<string, unknown>,
  extra: { usage?: unknown; request_id?: string } = {},
) {
  return { data, ...extra };
}

/** A worker-shaped collection-status 200 envelope (free route: no `usage`) — same shape as
 * ask.test.ts's own statusEnvelope helper, duplicated here rather than shared/imported since
 * neither test file exports fixtures across the other (each stays self-contained). */
function statusEnvelope(data: Record<string, unknown>, requestId = "r-status") {
  return { data, request_id: requestId };
}

describe("ingest: client-side validation runs BEFORE any request", () => {
  it("101 documents throws invalid_request with NO request issued", async () => {
    const fetchImpl = vi.fn();
    const client = new AgentRag({
      accountKey: AK,
      endpoint,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const documents = Array.from({ length: 101 }, (_, i) => ({
      text: `doc ${i}`,
    }));
    await expect(client.ingest({ documents })).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("a document with a non-string text throws invalid_request with NO request issued", async () => {
    const fetchImpl = vi.fn();
    const client = new AgentRag({
      accountKey: AK,
      endpoint,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(
      client.ingest({
        // @ts-expect-error deliberately non-string text, simulating an untyped caller
        documents: [{ text: 123 }],
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("a document with 100KiB+1 bytes of text throws invalid_request with NO request issued", async () => {
    const fetchImpl = vi.fn();
    const client = new AgentRag({
      accountKey: AK,
      endpoint,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const documents = [{ text: "x".repeat(100 * 1024 + 1) }];
    await expect(client.ingest({ documents })).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("exactly 100KiB of text (the boundary) does NOT throw client-side", async () => {
    // Boundary check: MAX_DOCUMENT_BYTES itself must be ACCEPTED, not just "one byte over"
    // rejected — a fencepost bug in the byte comparison would silently narrow the limit.
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify(
          ingestEnvelope({
            collection: "c-boundary",
            status: "complete",
            pages_total: 0,
            pages_failed: 0,
            chunks: 1,
            expires_at: "2026-09-01T00:00:00.000Z",
          }),
        ),
        { status: 200 },
      )) as unknown as typeof fetch;
    const client = new AgentRag({ accountKey: AK, endpoint, fetchImpl });
    const documents = [{ text: "x".repeat(100 * 1024) }];

    const result = await client.ingest({ documents });
    expect(result).toMatchObject({ collection: "c-boundary" });
  });

  it("an empty documents array throws invalid_request with NO request issued", async () => {
    const fetchImpl = vi.fn();
    const client = new AgentRag({
      accountKey: AK,
      endpoint,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.ingest({ documents: [] })).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("an empty sources array throws invalid_request with NO request issued", async () => {
    const fetchImpl = vi.fn();
    const client = new AgentRag({
      accountKey: AK,
      endpoint,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.ingest({ sources: [] })).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("a malformed source throws invalid_request with NO request issued", async () => {
    const fetchImpl = vi.fn();
    const client = new AgentRag({
      accountKey: AK,
      endpoint,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.ingest({ sources: ["ftp://x.test/a"] })).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("neither sources nor documents throws invalid_request with NO request issued", async () => {
    const fetchImpl = vi.fn();
    const client = new AgentRag({
      accountKey: AK,
      endpoint,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.ingest({})).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("an empty-string collection throws invalid_request with NO request issued", async () => {
    const fetchImpl = vi.fn();
    const client = new AgentRag({
      accountKey: AK,
      endpoint,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(
      client.ingest({ documents: [{ text: "hi" }], collection: "" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maxPages: 0 and maxPages: 201 both throw invalid_request with NO request issued", async () => {
    const fetchImpl = vi.fn();
    const client = new AgentRag({
      accountKey: AK,
      endpoint,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.ingest({ sources: ["https://a.com"], maxPages: 0 })).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(
      client.ingest({ sources: ["https://a.com"], maxPages: 201 }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("an unknown model throws invalid_request with NO request issued", async () => {
    const fetchImpl = vi.fn();
    const client = new AgentRag({
      accountKey: AK,
      endpoint,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(
      client.ingest({
        documents: [{ text: "hi" }],
        // @ts-expect-error deliberately invalid model, simulating an untyped caller
        model: "@cf/not-a-real-model",
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("RAG_MODELS lists exactly these four ids (value-level regression pin)", () => {
    // Renamed in fix round 2: this is NOT an exhaustiveness proof — `expected: RagModelId[]`
    // type-checks fine as any SUBSET of RagModelId, so it could not have caught RagModelId
    // outgrowing RAG_MODELS (a prior version of this test's own comment incorrectly claimed
    // it did). That invariant is now enforced separately, at compile time, by
    // `RagModelsAreExhaustive` beside RAG_MODELS's own declaration in index.ts — which fails
    // `tsc` directly the moment they disagree, rather than depending on this test noticing.
    // What THIS test catches is narrower but still real and distinct: an accidental edit to
    // RAG_MODELS's own listed VALUES (a typo, a duplicate, a dropped entry) that a pure
    // type-level check can't see, since each remaining string is still individually a valid
    // RagModelId either way.
    const expected: RagModelId[] = [
      "@cf/baai/bge-m3",
      "@cf/baai/bge-large-en-v1.5",
      "@cf/qwen/qwen3-embedding-0.6b",
      "@cf/google/embeddinggemma-300m",
    ];
    expect([...RAG_MODELS].sort()).toEqual([...expected].sort());
  });
});

describe("ingest: happy paths (envelope-wrapped fixtures — see file header)", () => {
  it("an explicit 2-url ingest sends `sources` and returns counts", async () => {
    let sentBody: Record<string, unknown> | undefined;
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      sentBody = JSON.parse(init?.body as string);
      return new Response(
        JSON.stringify(
          ingestEnvelope(
            {
              collection: "c1",
              status: "complete",
              pages_total: 2,
              pages_failed: 0,
              chunks: 8,
              expires_at: "2026-09-01T00:00:00.000Z",
            },
            {
              usage: {
                service: "rag",
                op: "ingest",
                price_usd: 0.01,
                list_price_usd: 0.01,
                credits_charged: 0,
              },
              request_id: "r1",
            },
          ),
        ),
        { status: 200, headers: { "X-AgentKV-Credits-Remaining": "10" } },
      );
    }) as unknown as typeof fetch;
    const client = new AgentRag({ accountKey: AK, endpoint, fetchImpl });

    const result = await client.ingest({
      sources: ["https://a.com/1", "https://a.com/2"],
      collection: "c1",
    });
    if (!("chunks" in result)) throw new Error("expected IngestResult, got AskPending");
    expect(sentBody?.sources).toEqual(["https://a.com/1", "https://a.com/2"]);
    expect(result.collection).toBe("c1");
    expect(result.pages_total).toBe(2);
    expect(result.pages_failed).toBe(0);
    expect(result.chunks).toBe(8);
    expect(result.creditsRemaining).toBe(10);
    expect(result.request_id).toBe("r1");
    expect(result.settledTxHash).toBe("");
  });

  it("model and refresh pass through to the request body", async () => {
    let sentBody: Record<string, unknown> | undefined;
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      sentBody = JSON.parse(init?.body as string);
      return new Response(
        JSON.stringify(
          ingestEnvelope({
            collection: "c5",
            status: "complete",
            pages_total: 1,
            pages_failed: 0,
            chunks: 2,
            expires_at: "2026-09-01T00:00:00.000Z",
          }),
        ),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const client = new AgentRag({ accountKey: AK, endpoint, fetchImpl });

    await client.ingest({
      sources: ["https://a.com/1"],
      collection: "c5",
      model: "@cf/baai/bge-large-en-v1.5",
      refresh: true,
    });
    expect(sentBody?.model).toBe("@cf/baai/bge-large-en-v1.5");
    expect(sentBody?.refresh).toBe(true);
  });

  it("a documents-only ingest sends no `sources`", async () => {
    let sentBody: Record<string, unknown> | undefined;
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      sentBody = JSON.parse(init?.body as string);
      return new Response(
        JSON.stringify(
          ingestEnvelope({
            collection: "c2",
            status: "complete",
            pages_total: 0,
            pages_failed: 0,
            chunks: 3,
            expires_at: "2026-09-01T00:00:00.000Z",
          }),
        ),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const client = new AgentRag({ accountKey: AK, endpoint, fetchImpl });

    const result = await client.ingest({
      documents: [{ text: "hello world" }],
      collection: "c2",
    });
    expect(sentBody).not.toHaveProperty("sources");
    expect(sentBody?.documents).toEqual([{ text: "hello world" }]);
    if (!("chunks" in result)) throw new Error("expected IngestResult, got AskPending");
    expect(result.collection).toBe("c2");
    expect(result.chunks).toBe(3);
  });

  it("account-key mode issues exactly ONE bearer request, never probes", async () => {
    const calls: RequestInit[] = [];
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      calls.push(init ?? {});
      return new Response(
        JSON.stringify(
          ingestEnvelope({
            collection: "c3",
            status: "complete",
            pages_total: 0,
            pages_failed: 0,
            chunks: 1,
            expires_at: "2026-09-01T00:00:00.000Z",
          }),
        ),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const client = new AgentRag({ accountKey: AK, endpoint, fetchImpl });

    await client.ingest({ documents: [{ text: "hi" }] });
    expect(calls).toHaveLength(1);
    expect(new Headers(calls[0]?.headers).get("Authorization")).toBe(`Bearer ${AK}`);
  });

  it("a job-path ingest (a crawl-root source) resolving 202 returns AskPending, WITH usage", async () => {
    // `usage` on the 202 fixture is load-bearing, not decorative: types.ts documents that
    // ingest's 202 ALWAYS carries `usage` (unlike ask's, whose 202 precedes its own
    // pay-on-success charge) — ingest's job path settles the charge BEFORE returning the
    // 202. A fixture omitting it can't tell a client that forgets to surface `env.usage`
    // apart from one that never gets a `usage` block on this path at all.
    let sentBody: Record<string, unknown> | undefined;
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      sentBody = JSON.parse(init?.body as string);
      return new Response(
        JSON.stringify(
          ingestEnvelope(
            {
              collection: "c4",
              status: "ingesting",
              pages_done: 0,
              pages_total: 5,
              retry_after: 15,
            },
            {
              usage: {
                service: "rag",
                op: "ingest",
                price_usd: 0.025,
                list_price_usd: 0.025,
                credits_charged: 0,
              },
              request_id: "r2",
            },
          ),
        ),
        { status: 202 },
      );
    }) as unknown as typeof fetch;
    const client = new AgentRag({ accountKey: AK, endpoint, fetchImpl });

    const result = await client.ingest({
      sources: ["https://a.com/**"],
      maxPages: 5,
    });
    expect(sentBody?.max_pages).toBe(5);
    expect(result).toMatchObject({
      collection: "c4",
      status: "ingesting",
      pages_done: 0,
      pages_total: 5,
      retry_after: 15,
      request_id: "r2",
      usage: {
        service: "rag",
        op: "ingest",
        price_usd: 0.025,
      },
    });
  });
});

describe("ingest: composite authorized ceiling (money-safety)", () => {
  it("a challenge quoting more than the (sources, maxPages)-derived ceiling is refused BEFORE signing", async () => {
    let produced = 0;
    const spy = {
      ...signer,
      signTypedData: (async (args: Parameters<typeof signer.signTypedData>[0]) => {
        produced++;
        return signer.signTypedData(args);
      }) as typeof signer.signTypedData,
    } as typeof signer;
    // 1 worst-case source page, no documents, default maxPages (20): 1 * 0.005 = 0.005.
    const ceiling = ingestAuthorizedCeilingUsd(["https://a.com"], 0, 20);
    const fetchImpl = (async () =>
      new Response("{}", {
        status: 402,
        headers: {
          "PAYMENT-REQUIRED": challenge(String(usdToAtomic(ceiling + 0.01))),
        },
      })) as unknown as typeof fetch;
    const client = new AgentRag({ signer: spy, endpoint, fetchImpl });

    await expect(client.ingest({ sources: ["https://a.com"] })).rejects.toBeInstanceOf(
      SpendCapError,
    );
    expect(produced).toBe(0); // no signature was ever produced, not merely unsent
  });

  it("an honest quote at the ceiling is signed (the guard does not false-reject its own ceiling)", async () => {
    let signed = false;
    const ceiling = ingestAuthorizedCeilingUsd(["https://a.com"], 0, 20);
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      if (init && new Headers(init.headers).get("PAYMENT-SIGNATURE")) {
        signed = true;
        return new Response(
          JSON.stringify(
            ingestEnvelope({
              collection: "c5",
              status: "complete",
              pages_total: 1,
              pages_failed: 0,
              chunks: 2,
              expires_at: "2026-09-01T00:00:00.000Z",
            }),
          ),
          { status: 200 },
        );
      }
      return new Response("{}", {
        status: 402,
        headers: {
          "PAYMENT-REQUIRED": challenge(String(usdToAtomic(ceiling))),
        },
      });
    }) as unknown as typeof fetch;
    const client = new AgentRag({ signer, endpoint, fetchImpl });

    const result = await client.ingest({ sources: ["https://a.com"] });
    expect(signed).toBe(true);
    expect("chunks" in result).toBe(true);
  });
});

describe("ingestAndWait", () => {
  it("rejects an invalid maxWaitMs BEFORE issuing any request", async () => {
    const fetchImpl = vi.fn();
    const client = new AgentRag({
      accountKey: AK,
      endpoint,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(
      client.ingestAndWait({ sources: ["https://a.com"], maxWaitMs: Number.NaN }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      client.ingestAndWait({ sources: ["https://a.com"], maxWaitMs: 0 }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns the sync IngestResult untouched when ingest resolves inline (no 202) — never polls", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify(
            ingestEnvelope({
              collection: "c6",
              status: "complete",
              pages_total: 1,
              pages_failed: 0,
              chunks: 2,
              expires_at: "2026-09-01T00:00:00.000Z",
            }),
          ),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;
    const client = new AgentRag({ accountKey: AK, endpoint, fetchImpl });

    const result = await client.ingestAndWait({ sources: ["https://a.com"] });
    expect(result).toMatchObject({
      collection: "c6",
      status: "complete",
      pages_total: 1,
      pages_failed: 0,
      chunks: 2,
    });
    // No 202 -> no poll, no second ingest. Exactly the one bearer call.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("polls until the job leaves 'running', then assembles an IngestResult from the 202 and the terminal status — and never re-ingests (no double charge)", async () => {
    const calls: Array<{ method: string; url: string }> = [];
    let step = 0;
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      const method = init?.method ?? "GET";
      calls.push({ method, url });
      step++;
      if (step === 1) {
        // ingest() -> still ingesting. Its charge has already settled (usage present).
        return new Response(
          JSON.stringify(
            ingestEnvelope(
              {
                collection: "c9",
                status: "ingesting",
                pages_done: 0,
                pages_total: 5,
                retry_after: 0,
              },
              {
                usage: {
                  service: "rag",
                  op: "ingest",
                  price_usd: 0.025,
                  list_price_usd: 0.025,
                  credits_charged: 0,
                },
                request_id: "r-ingest",
              },
            ),
          ),
          { status: 202 },
        );
      }
      if (step === 2) {
        // first poll (pollIngestJobState) -> still running
        return new Response(
          JSON.stringify(
            statusEnvelope({
              collection: "c9",
              model: "@cf/baai/bge-m3",
              pages: 3,
              chunks: 0,
              created_at: "2026-08-01T00:00:00.000Z",
              expires_at: "2026-09-01T00:00:00.000Z",
              job: { pages_done: 3, pages_total: 5, state: "running" },
            }),
          ),
          { status: 200 },
        );
      }
      // second poll (pollIngestJobState observes terminal) AND the one additional status()
      // read afterwards both see the same terminal snapshot — carries the failure detail
      // ingestAndWait must surface (pages_ok/pages_failed/failures/refunded_credits).
      return new Response(
        JSON.stringify(
          statusEnvelope({
            collection: "c9",
            model: "@cf/baai/bge-m3",
            pages: 5,
            chunks: 12,
            created_at: "2026-08-01T00:00:00.000Z",
            expires_at: "2026-09-05T00:00:00.000Z",
            job: {
              pages_done: 5,
              pages_total: 5,
              state: "failed",
              pages_ok: 3,
              pages_failed: 2,
              failures: [{ url: "https://a.com/p4", reason: "thin_content" }],
              refunded_credits: 10,
            },
          }),
        ),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const client = new AgentRag({ accountKey: AK, endpoint, fetchImpl });

    const result = await client.ingestAndWait({
      sources: ["https://a.com/**"],
      pollIntervalMs: 0,
      maxWaitMs: 5_000,
    });

    expect(step).toBe(4); // POST ingest -> GET poll(running) -> GET poll(terminal) -> GET status
    expect(result).toMatchObject({
      collection: "c9",
      status: "failed",
      pages_total: 5, // from the 202
      pages_ok: 3, // from the terminal job block
      pages_failed: 2,
      refunded_credits: 10,
      chunks: 12, // from the terminal status(), not the 202
      expires_at: "2026-09-05T00:00:00.000Z",
      request_id: "r-ingest", // from the 202 — the only response carrying it
      usage: { service: "rag", op: "ingest", price_usd: 0.025 },
    });
    expect(result.failures).toHaveLength(1);
    expect(result.failures?.[0]).toMatchObject({ reason: "thin_content" });

    // The money-safety assertion: exactly ONE POST to /v1/rag/ingest across the whole
    // call. Re-issuing ingest() after the wait would double-charge for work already paid
    // for — see ingestAndWait's own doc comment.
    const ingestPosts = calls.filter(
      (c) => c.method === "POST" && c.url === `${endpoint}/v1/rag/ingest`,
    );
    expect(ingestPosts).toHaveLength(1);
    expect(calls.map((c) => c.method)).toEqual(["POST", "GET", "GET", "GET"]);
  });

  it("throws ingest_timeout once maxWaitMs elapses while the job keeps reporting 'running' — and still never re-ingests", async () => {
    let ingestCalls = 0;
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "POST") {
        ingestCalls++;
        return new Response(
          JSON.stringify(
            ingestEnvelope({
              collection: "c9",
              status: "ingesting",
              pages_done: 0,
              pages_total: 5,
              retry_after: 0,
            }),
          ),
          { status: 202 },
        );
      }
      return new Response(
        JSON.stringify(
          statusEnvelope({
            collection: "c9",
            model: "@cf/baai/bge-m3",
            pages: 0,
            chunks: 0,
            created_at: "2026-08-01T00:00:00.000Z",
            expires_at: "2026-09-01T00:00:00.000Z",
            job: { pages_done: 0, pages_total: 5, state: "running" },
          }),
        ),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const client = new AgentRag({ accountKey: AK, endpoint, fetchImpl });

    await expect(
      client.ingestAndWait({
        sources: ["https://a.com/**"],
        pollIntervalMs: 5,
        maxWaitMs: 30,
      }),
    ).rejects.toMatchObject({ code: "ingest_timeout" });
    expect(ingestCalls).toBe(1); // one paid ingest call, never repeated on timeout
  }, 2_000);
});
