import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import {
  AgentRag,
  AgentRagError,
  DEFAULT_ASK_POLL_INTERVAL_MS,
  MIN_SERVER_POLL_INTERVAL_MS,
  SpendCapError,
} from "../src/index";
import { askAuthorizedCeilingUsd } from "../src/pricing";

// Every 200/202 fixture in this file mirrors the REAL wire envelope
// (`{ data, request_id, usage? }`), not the SDK's own flattened result types — verified
// against the worker's own test suite, which asserts `body.data.*` throughout. A fixture
// written from `AskResult`'s shape instead of the wire shape is exactly the blind spot
// that let a broken production path pass 97/97 tests in the prior round.

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
          resource: "/v1/rag/ask",
          description: "ask",
          mimeType: "application/json",
          maxTimeoutSeconds: 300,
        },
      ],
    }),
  );
}

/** A worker-shaped ask 200 envelope: `{data: {...}, usage?, request_id?}`. */
function askEnvelope(
  data: Record<string, unknown>,
  extra: { usage?: unknown; request_id?: string } = {},
) {
  return { data, ...extra };
}

/** A worker-shaped collection-status 200 envelope (free route: no `usage`). */
function statusEnvelope(data: Record<string, unknown>, requestId = "r-status") {
  return { data, request_id: requestId };
}

describe("ask: client-side validation runs BEFORE any request", () => {
  it("top_k: 100 throws an AgentRagError coded invalid_request, with NO request issued", async () => {
    const fetchImpl = vi.fn();
    const client = new AgentRag({
      signer,
      endpoint,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const err = await client.ask("hi", { collection: "c1", topK: 100 }).catch((e) => e);
    expect(err).toBeInstanceOf(AgentRagError);
    expect(err).toMatchObject({ code: "invalid_request" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("a non-integer topK throws invalid_request with NO request issued", async () => {
    const fetchImpl = vi.fn();
    const client = new AgentRag({
      signer,
      endpoint,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.ask("hi", { collection: "c1", topK: 2.5 })).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("a 1001-char query throws invalid_request with NO request issued", async () => {
    const fetchImpl = vi.fn();
    const client = new AgentRag({
      signer,
      endpoint,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.ask("x".repeat(1001), { collection: "c1" })).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("an empty (whitespace-only) query throws invalid_request with NO request issued", async () => {
    const fetchImpl = vi.fn();
    const client = new AgentRag({
      signer,
      endpoint,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.ask("   ", { collection: "c1" })).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("an empty collection throws invalid_request with NO request issued (parity with ingest/extend/status)", async () => {
    // ask() was the only paying verb that reached the network on an empty collection, burning
    // a wallet-mode signature on a body the worker would 400. It now runs the same
    // assertValidCollectionName guard every other collection-taking verb does, pre-request.
    const fetchImpl = vi.fn();
    const client = new AgentRag({
      signer,
      endpoint,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.ask("what is x", { collection: "" })).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("an out-of-enum mode throws invalid_request with NO request issued", async () => {
    const fetchImpl = vi.fn();
    const client = new AgentRag({
      signer,
      endpoint,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(
      // @ts-expect-error deliberately invalid mode, simulating an untyped caller
      client.ask("hi", { collection: "c1", mode: "keyword" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maxPages: 0 and maxPages: 201 both throw invalid_request with NO request issued", async () => {
    const fetchImpl = vi.fn();
    const client = new AgentRag({
      signer,
      endpoint,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.ask("hi", { collection: "c1", maxPages: 0 })).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(client.ask("hi", { collection: "c1", maxPages: 201 })).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("a malformed source (mid-path '**') throws invalid_request with NO request issued", async () => {
    const fetchImpl = vi.fn();
    const client = new AgentRag({
      signer,
      endpoint,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.ask("hi", { sources: ["https://x.test/**/docs"] })).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("a non-http(s) source throws invalid_request with NO request issued", async () => {
    const fetchImpl = vi.fn();
    const client = new AgentRag({
      signer,
      endpoint,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.ask("hi", { sources: ["ftp://x.test/a"] })).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("a source that isn't a parseable URL at all throws invalid_request with NO request issued", async () => {
    const fetchImpl = vi.fn();
    const client = new AgentRag({
      signer,
      endpoint,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.ask("hi", { sources: ["not a url"] })).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("an empty sources array throws invalid_request with NO request issued (M4)", async () => {
    // Distinct from the malformed-entry cases above: `sources: []` passes the per-entry
    // loop vacuously (zero iterations) AND passes "at least one of sources/collection"
    // (sources IS defined) — the worker's own parseAskBody rejects it separately
    // ("sources, if present, must be a non-empty array"), so the client must too, or a
    // wallet-mode caller burns a real EIP-3009 signature on a request the worker 400s.
    const fetchImpl = vi.fn();
    const client = new AgentRag({
      signer,
      endpoint,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.ask("hi", { sources: [] })).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("neither sources nor collection throws invalid_request with NO request issued", async () => {
    const fetchImpl = vi.fn();
    const client = new AgentRag({
      signer,
      endpoint,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.ask("hi", {})).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("ask: happy paths (envelope-wrapped fixtures — see file header)", () => {
  it("a paid ask (flat price, wallet mode) unwraps data/usage/request_id and returns chunks", async () => {
    let calls = 0;
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      calls++;
      if (!(init && new Headers(init.headers).get("PAYMENT-SIGNATURE"))) {
        return new Response("{}", {
          status: 402,
          headers: { "PAYMENT-REQUIRED": challenge("8000") },
        });
      }
      return new Response(
        JSON.stringify(
          askEnvelope(
            {
              collection: "c1",
              expires_at: "2026-09-01T00:00:00.000Z",
              matched: true,
              chunks: [{ text: "hi", score: 0.9, url: null, title: null, position: 0 }],
            },
            {
              usage: {
                service: "rag",
                op: "ask",
                price_usd: 0.008,
                list_price_usd: 0.008,
                credits_charged: 0,
              },
              request_id: "r1",
            },
          ),
        ),
        { status: 200, headers: { "X-AgentKV-Credits-Remaining": "42" } },
      );
    }) as unknown as typeof fetch;
    const client = new AgentRag({ signer, endpoint, fetchImpl });

    const result = await client.ask("what is x", { collection: "c1" });
    if (!("chunks" in result)) throw new Error("expected AskResult, got AskPending");
    expect(result.collection).toBe("c1");
    expect(result.matched).toBe(true);
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.text).toBe("hi");
    expect(result.usage?.price_usd).toBe(0.008);
    expect(result.request_id).toBe("r1");
    expect(result.creditsRemaining).toBe(42);
    expect(result.settledTxHash).toBe(""); // no PAYMENT-RESPONSE header on this fixture
    expect(calls).toBe(2); // bare probe, then the paid retry
  });

  it("account-key mode issues exactly ONE bearer request, never probes", async () => {
    const calls: RequestInit[] = [];
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      calls.push(init ?? {});
      return new Response(
        JSON.stringify(
          askEnvelope({
            collection: "c1",
            expires_at: "2026-09-01T00:00:00.000Z",
            matched: true,
            chunks: [],
          }),
        ),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const client = new AgentRag({ accountKey: AK, endpoint, fetchImpl });

    const result = await client.ask("what is x", { collection: "c1" });
    expect(calls).toHaveLength(1);
    expect(new Headers(calls[0].headers).get("Authorization")).toBe(`Bearer ${AK}`);
    if (!("chunks" in result)) throw new Error("expected AskResult, got AskPending");
    expect(result.collection).toBe("c1");
  });

  it("topK, mode, maxPages, and refresh pass through to the request body", async () => {
    let sentBody: Record<string, unknown> | undefined;
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      sentBody = JSON.parse(init?.body as string);
      return new Response(
        JSON.stringify(
          askEnvelope({
            collection: "c1",
            expires_at: "2026-09-01T00:00:00.000Z",
            matched: true,
            chunks: [],
          }),
        ),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const client = new AgentRag({ accountKey: AK, endpoint, fetchImpl });

    await client.ask("what is x", {
      collection: "c1",
      topK: 5,
      mode: "dense",
      maxPages: 10,
      refresh: true,
    });
    expect(sentBody?.top_k).toBe(5);
    expect(sentBody?.mode).toBe("dense");
    expect(sentBody?.max_pages).toBe(10);
    expect(sentBody?.refresh).toBe(true);
  });

  it("a 202 unwraps data and resolves as AskPending, not an error", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify(
          askEnvelope(
            {
              collection: "c1",
              status: "ingesting",
              pages_done: 1,
              pages_total: 5,
              retry_after: 15,
            },
            { request_id: "r2" },
          ),
        ),
        { status: 202 },
      )) as unknown as typeof fetch;
    const client = new AgentRag({ accountKey: AK, endpoint, fetchImpl });

    const result = await client.ask("what is x", {
      sources: ["https://a.com/**"],
    });
    expect(result).toMatchObject({
      collection: "c1",
      status: "ingesting",
      pages_done: 1,
      pages_total: 5,
      retry_after: 15,
      request_id: "r2",
    });
  });
});

describe("ask: composite-aware authorized ceiling (spec §11.3)", () => {
  it("a composite ask's authorized ceiling equals (1+2) x 0.005 = 0.015, matching pricing.ts", () => {
    expect(askAuthorizedCeilingUsd(["https://a.com"], 20)).toBeCloseTo(0.015, 9);
  });

  it("a challenge quoting $0.02 against a $0.015 composite ceiling is refused BEFORE signing", async () => {
    let produced = 0;
    const spy = {
      ...signer,
      signTypedData: (async (args: Parameters<typeof signer.signTypedData>[0]) => {
        produced++;
        return signer.signTypedData(args);
      }) as typeof signer.signTypedData,
    } as typeof signer;
    const fetchImpl = (async () =>
      new Response("{}", {
        status: 402,
        headers: { "PAYMENT-REQUIRED": challenge("20000") }, // $0.02
      })) as unknown as typeof fetch;
    const client = new AgentRag({ signer: spy, endpoint, fetchImpl });

    await expect(client.ask("hi", { sources: ["https://a.com"] })).rejects.toBeInstanceOf(
      SpendCapError,
    );
    expect(produced).toBe(0); // no signature was ever produced, not merely unsent
  });

  it("an honest $0.015 composite quote is signed (the guard does not false-reject its own ceiling)", async () => {
    let signed = false;
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      if (init && new Headers(init.headers).get("PAYMENT-SIGNATURE")) {
        signed = true;
        return new Response(
          JSON.stringify(
            askEnvelope({
              collection: "c1",
              expires_at: "2026-09-01T00:00:00.000Z",
              matched: true,
              chunks: [],
            }),
          ),
          { status: 200 },
        );
      }
      return new Response("{}", {
        status: 402,
        headers: { "PAYMENT-REQUIRED": challenge("15000") }, // $0.015
      });
    }) as unknown as typeof fetch;
    const client = new AgentRag({ signer, endpoint, fetchImpl });

    const result = await client.ask("hi", { sources: ["https://a.com"] });
    expect(signed).toBe(true);
    expect("chunks" in result).toBe(true);
  });
});

describe("askAndWait: maxWaitMs / pollIntervalMs validation (I1)", () => {
  it("a NaN maxWaitMs throws invalid_request with NO request issued", async () => {
    const fetchImpl = vi.fn();
    const client = new AgentRag({
      accountKey: AK,
      endpoint,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(
      client.askAndWait("hi", { collection: "c1", maxWaitMs: Number.NaN }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("a zero or negative maxWaitMs throws invalid_request with NO request issued", async () => {
    const fetchImpl = vi.fn();
    const client = new AgentRag({
      accountKey: AK,
      endpoint,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.askAndWait("hi", { collection: "c1", maxWaitMs: 0 })).rejects.toMatchObject(
      { code: "invalid_request" },
    );
    await expect(
      client.askAndWait("hi", { collection: "c1", maxWaitMs: -1 }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("a NaN pollIntervalMs throws invalid_request with NO request issued", async () => {
    const fetchImpl = vi.fn();
    const client = new AgentRag({
      accountKey: AK,
      endpoint,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(
      client.askAndWait("hi", { collection: "c1", pollIntervalMs: Number.NaN }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("a negative pollIntervalMs throws invalid_request with NO request issued", async () => {
    const fetchImpl = vi.fn();
    const client = new AgentRag({
      accountKey: AK,
      endpoint,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(
      client.askAndWait("hi", { collection: "c1", pollIntervalMs: -1 }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("askAndWait", () => {
  it("polls until the ingest job leaves 'running', then re-asks the resolved collection and returns the AskResult", async () => {
    const calls: Array<{ method: string; url: string; body?: string }> = [];
    let step = 0;
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      calls.push({
        method: init?.method ?? "GET",
        url,
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      step++;
      if (step === 1) {
        // initial ask (account-key: one bearer call) -> still ingesting
        return new Response(
          JSON.stringify(
            askEnvelope({
              collection: "c1",
              status: "ingesting",
              pages_done: 0,
              pages_total: 1,
              retry_after: 0,
            }),
          ),
          { status: 202 },
        );
      }
      if (step === 2) {
        // first poll -> still running
        return new Response(
          JSON.stringify(
            statusEnvelope({
              collection: "c1",
              model: "@cf/baai/bge-m3",
              pages: 0,
              chunks: 0,
              created_at: "2026-08-01T00:00:00.000Z",
              expires_at: "2026-09-01T00:00:00.000Z",
              job: { pages_done: 0, pages_total: 1, state: "running" },
            }),
          ),
          { status: 200 },
        );
      }
      if (step === 3) {
        // second poll -> complete
        return new Response(
          JSON.stringify(
            statusEnvelope({
              collection: "c1",
              model: "@cf/baai/bge-m3",
              pages: 1,
              chunks: 4,
              created_at: "2026-08-01T00:00:00.000Z",
              expires_at: "2026-09-01T00:00:00.000Z",
              job: { pages_done: 1, pages_total: 1, state: "complete" },
            }),
          ),
          { status: 200 },
        );
      }
      // re-ask, targeting the now-resolved collection
      return new Response(
        JSON.stringify(
          askEnvelope(
            {
              collection: "c1",
              expires_at: "2026-09-01T00:00:00.000Z",
              matched: true,
              chunks: [
                {
                  text: "final",
                  score: 0.9,
                  url: null,
                  title: null,
                  position: 0,
                },
              ],
            },
            {
              usage: {
                service: "rag",
                op: "ask",
                price_usd: 0.008,
                list_price_usd: 0.008,
                credits_charged: 0,
              },
            },
          ),
        ),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const client = new AgentRag({ accountKey: AK, endpoint, fetchImpl });

    const result = await client.askAndWait("what is x", {
      sources: ["https://a.com"],
      pollIntervalMs: 0,
      maxWaitMs: 5_000,
    });
    expect(result.chunks).toHaveLength(1);
    expect(result.matched).toBe(true);
    expect(step).toBe(4);

    // Pin the exact protocol sequence: POST ask -> GET poll -> GET poll -> POST re-ask.
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: `${endpoint}/v1/rag/ask`,
    });
    expect(calls[1]).toMatchObject({
      method: "GET",
      url: `${endpoint}/v1/rag/collection/c1`,
    });
    expect(calls[2]).toMatchObject({
      method: "GET",
      url: `${endpoint}/v1/rag/collection/c1`,
    });
    expect(calls[3]).toMatchObject({
      method: "POST",
      url: `${endpoint}/v1/rag/ask`,
    });

    // The re-ask targets the resolved collection directly and drops `sources` — re-sending
    // it would re-quote (and, in wallet mode, re-sign) a full composite ingest charge for
    // work that is already done.
    const reAskBody = JSON.parse(calls[3].body ?? "{}");
    expect(reAskBody.collection).toBe("c1");
    expect(reAskBody.sources).toBeUndefined();
  });

  it("honors the 202's own retry_after for the poll delay when pollIntervalMs is omitted", async () => {
    // askAndWait's own doc comment: "ordinarily the wait between polls is governed by the
    // 202's own retry_after ... not this constant [DEFAULT_ASK_POLL_INTERVAL_MS]". Every
    // OTHER askAndWait test in this file passes an explicit pollIntervalMs (usually 0) to
    // skip waiting deterministically — this is the one test that drives the real production
    // default path: no pollIntervalMs override, and a genuine positive retry_after on the
    // 202. retry_after: 2 -> a 2000ms poll delay (above MIN_SERVER_POLL_INTERVAL_MS, so the
    // server value passes through un-floored), proven via a setTimeout spy rather than merely
    // a short test timeout, so a regression that used some OTHER hardcoded delay (not the 15s
    // fallback, but also not the server's real value) would still be caught. The sub-floor
    // clamp is covered by its own test below.
    let step = 0;
    const fetchImpl = (async () => {
      step++;
      if (step === 1) {
        return new Response(
          JSON.stringify(
            askEnvelope({
              collection: "c1",
              status: "ingesting",
              pages_done: 0,
              pages_total: 1,
              retry_after: 2,
            }),
          ),
          { status: 202 },
        );
      }
      if (step === 2) {
        return new Response(
          JSON.stringify(
            statusEnvelope({
              collection: "c1",
              model: "@cf/baai/bge-m3",
              pages: 1,
              chunks: 4,
              created_at: "2026-08-01T00:00:00.000Z",
              expires_at: "2026-09-01T00:00:00.000Z",
              job: { pages_done: 1, pages_total: 1, state: "complete" },
            }),
          ),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify(
          askEnvelope({
            collection: "c1",
            expires_at: "2026-09-01T00:00:00.000Z",
            matched: true,
            chunks: [],
          }),
        ),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const client = new AgentRag({ accountKey: AK, endpoint, fetchImpl });
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    const result = await client.askAndWait("what is x", {
      sources: ["https://a.com"],
      maxWaitMs: 5_000,
      // pollIntervalMs deliberately OMITTED.
    });

    expect(result.matched).toBe(true);
    const delays = setTimeoutSpy.mock.calls.map((call) => call[1]);
    expect(delays).toContain(2000); // retry_after (2s) * 1000, actually used (above the floor)
    expect(delays).not.toContain(DEFAULT_ASK_POLL_INTERVAL_MS); // the fallback, NOT used
    setTimeoutSpy.mockRestore();
  });

  it("floors a sub-second server retry_after to MIN_SERVER_POLL_INTERVAL_MS", async () => {
    // A hostile/buggy service returning retry_after: 0.001 must NOT be able to dictate a
    // ~1ms poll+re-ask loop at network speed (an unbounded-work vector — the re-ask leg is
    // paid). The server-supplied value is clamped to MIN_SERVER_POLL_INTERVAL_MS; an
    // EXPLICIT pollIntervalMs (including 0) is a caller decision and is never floored.
    let step = 0;
    const fetchImpl = (async () => {
      step++;
      if (step === 1) {
        return new Response(
          JSON.stringify(
            askEnvelope({
              collection: "c1",
              status: "ingesting",
              pages_done: 0,
              pages_total: 1,
              retry_after: 0.001, // 1ms if honored verbatim — must be floored to 1000
            }),
          ),
          { status: 202 },
        );
      }
      if (step === 2) {
        return new Response(
          JSON.stringify(
            statusEnvelope({
              collection: "c1",
              model: "@cf/baai/bge-m3",
              pages: 1,
              chunks: 4,
              created_at: "2026-08-01T00:00:00.000Z",
              expires_at: "2026-09-01T00:00:00.000Z",
              job: { pages_done: 1, pages_total: 1, state: "complete" },
            }),
          ),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify(
          askEnvelope({
            collection: "c1",
            expires_at: "2026-09-01T00:00:00.000Z",
            matched: true,
            chunks: [],
          }),
        ),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const client = new AgentRag({ accountKey: AK, endpoint, fetchImpl });
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    await client.askAndWait("what is x", {
      sources: ["https://a.com"],
      maxWaitMs: 5_000,
      // pollIntervalMs deliberately OMITTED — the server value governs, but floored.
    });

    const delays = setTimeoutSpy.mock.calls.map((call) => call[1]);
    expect(delays).toContain(MIN_SERVER_POLL_INTERVAL_MS); // 1000, the floor
    expect(delays).not.toContain(1); // the un-floored 1ms value must NEVER be used
    setTimeoutSpy.mockRestore();
  });

  /** Drives the same ask -> 202 -> poll(running) -> poll(complete) -> re-ask sequence as
   * the happy-path test above, but records the `Idempotency-Key` header on every call so
   * these tests can assert on it (I2). */
  function scriptedFourStepFlow(calls: Array<{ method: string; idempotencyKey: string | null }>) {
    let step = 0;
    return (async (input: unknown, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({
        method,
        idempotencyKey: init ? new Headers(init.headers).get("Idempotency-Key") : null,
      });
      void input;
      step++;
      if (step === 1) {
        return new Response(
          JSON.stringify(
            askEnvelope({
              collection: "c1",
              status: "ingesting",
              pages_done: 0,
              pages_total: 1,
              retry_after: 0,
            }),
          ),
          { status: 202 },
        );
      }
      if (step === 2) {
        return new Response(
          JSON.stringify(
            statusEnvelope({
              collection: "c1",
              model: "@cf/baai/bge-m3",
              pages: 0,
              chunks: 0,
              created_at: "2026-08-01T00:00:00.000Z",
              expires_at: "2026-09-01T00:00:00.000Z",
              job: { pages_done: 0, pages_total: 1, state: "running" },
            }),
          ),
          { status: 200 },
        );
      }
      if (step === 3) {
        return new Response(
          JSON.stringify(
            statusEnvelope({
              collection: "c1",
              model: "@cf/baai/bge-m3",
              pages: 1,
              chunks: 4,
              created_at: "2026-08-01T00:00:00.000Z",
              expires_at: "2026-09-01T00:00:00.000Z",
              job: { pages_done: 1, pages_total: 1, state: "complete" },
            }),
          ),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify(
          askEnvelope({
            collection: "c1",
            expires_at: "2026-09-01T00:00:00.000Z",
            matched: true,
            chunks: [],
          }),
        ),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
  }

  it("I2: the re-ask derives `<callerKey>:ask` from a caller-supplied idempotencyKey", async () => {
    const calls: Array<{ method: string; idempotencyKey: string | null }> = [];
    const client = new AgentRag({
      accountKey: AK,
      endpoint,
      fetchImpl: scriptedFourStepFlow(calls),
    });

    await client.askAndWait("what is x", {
      sources: ["https://a.com"],
      idempotencyKey: "caller-key",
      pollIntervalMs: 0,
      maxWaitMs: 5_000,
    });

    expect(calls).toHaveLength(4);
    // The initial ask keeps the caller's own key verbatim (unaffected by this fix).
    expect(calls[0]).toMatchObject({
      method: "POST",
      idempotencyKey: "caller-key",
    });
    // The re-ask (the billing leg) gets a key DERIVED from the caller's — extending
    // their exactly-once guarantee to the leg that actually settles a charge, without
    // reusing the exact string (which would re-derive the first leg's already-used
    // EIP-3009 nonce in wallet mode — see askAndWait's doc comment).
    expect(calls[3]).toMatchObject({
      method: "POST",
      idempotencyKey: "caller-key:ask",
    });
  });

  it("I2: the default-path re-ask key is a STABLE derived nonce, distinct from the initial ask", async () => {
    const calls: Array<{ method: string; idempotencyKey: string | null }> = [];
    const client = new AgentRag({
      accountKey: AK,
      endpoint,
      fetchImpl: scriptedFourStepFlow(calls),
    });

    await client.askAndWait("what is x", {
      sources: ["https://a.com"],
      pollIntervalMs: 0,
      maxWaitMs: 5_000,
      // idempotencyKey deliberately OMITTED — the default path.
    });

    expect(calls).toHaveLength(4);
    const initialKey = calls[0]?.idempotencyKey;
    const reAskKey = calls[3]?.idempotencyKey;
    expect(initialKey).toBeTruthy();
    // Money-safety: even with no caller key, the re-ask key is a single stable base with the
    // `:ask` suffix — reused verbatim across EVERY re-ask iteration, so all re-ask legs sign
    // one EIP-3009 nonce and at most one is settleable on-chain. A prior version generated a
    // fresh un-suffixed nonce per iteration, minting an unbounded number of separately
    // settleable authorizations. Distinct from the initial ask's key, whose amount differs.
    expect(reAskKey).toMatch(/:ask$/);
    expect(reAskKey).not.toBe(initialKey);
    expect(reAskKey).not.toBe("undefined:ask"); // never a fixed literal from a missing base
  });

  it("I2: every re-ask iteration reuses ONE nonce (no per-iteration mint) on the default path", async () => {
    // The money-safety core of H1: drive multiple re-ask iterations (the job keeps flapping
    // back to a fresh 202) and assert every paid re-ask carries the SAME Idempotency-Key, so
    // nonceFromIdempotencyKey yields one nonce and only one authorization can ever settle.
    const askKeys: string[] = [];
    let step = 0;
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      step++;
      if (method === "POST") {
        askKeys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
        // Always return a fresh 202 -> the loop must re-ask again next iteration.
        return new Response(
          JSON.stringify(
            askEnvelope({
              collection: "c1",
              status: "ingesting",
              pages_done: 0,
              pages_total: 1,
              retry_after: 0,
            }),
          ),
          { status: 202 },
        );
      }
      // status: report the job complete so the poll breaks and the loop re-asks.
      return new Response(
        JSON.stringify(
          statusEnvelope({
            collection: "c1",
            model: "@cf/baai/bge-m3",
            pages: 0,
            chunks: 0,
            created_at: "2026-08-01T00:00:00.000Z",
            expires_at: "2026-09-01T00:00:00.000Z",
            job: { pages_done: 1, pages_total: 1, state: "complete" },
          }),
        ),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const client = new AgentRag({ accountKey: AK, endpoint, fetchImpl });

    await expect(
      client.askAndWait("what is x", {
        sources: ["https://a.com"],
        pollIntervalMs: 0,
        maxWaitMs: 60,
      }),
    ).rejects.toMatchObject({ code: "ingest_timeout" });

    void step;
    // The initial ask uses its own key; every subsequent re-ask shares one key.
    const reAskKeys = askKeys.slice(1);
    expect(reAskKeys.length).toBeGreaterThan(1); // the loop really did re-ask repeatedly
    expect(new Set(reAskKeys).size).toBe(1); // ...all under a SINGLE idempotency key/nonce
    expect(reAskKeys[0]).toMatch(/:ask$/);
  });

  it("throws ingest_timeout once maxWaitMs elapses while the job keeps reporting 'running'", async () => {
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "POST") {
        return new Response(
          JSON.stringify(
            askEnvelope({
              collection: "c1",
              status: "ingesting",
              pages_done: 0,
              pages_total: 1,
              retry_after: 0,
            }),
          ),
          { status: 202 },
        );
      }
      return new Response(
        JSON.stringify(
          statusEnvelope({
            collection: "c1",
            model: "@cf/baai/bge-m3",
            pages: 0,
            chunks: 0,
            created_at: "2026-08-01T00:00:00.000Z",
            expires_at: "2026-09-01T00:00:00.000Z",
            job: { pages_done: 0, pages_total: 1, state: "running" },
          }),
        ),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const client = new AgentRag({ accountKey: AK, endpoint, fetchImpl });

    await expect(
      client.askAndWait("what is x", {
        sources: ["https://a.com"],
        pollIntervalMs: 5,
        maxWaitMs: 30,
      }),
    ).rejects.toMatchObject({ code: "ingest_timeout" });
  }, 2_000);

  it("returns immediately (no polling) when the first ask already resolves", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify(
          askEnvelope({
            collection: "c1",
            expires_at: "2026-09-01T00:00:00.000Z",
            matched: true,
            chunks: [],
          }),
        ),
        { status: 200 },
      )) as unknown as typeof fetch;
    const client = new AgentRag({ accountKey: AK, endpoint, fetchImpl });

    const result = await client.askAndWait("what is x", { collection: "c1" });
    expect(result.matched).toBe(true);
  });

  it("a status response with no job block at all is treated as terminal (not 'running')", async () => {
    // C2 regression guard, positive case: a collection with no active/tracked job (e.g. one
    // that never needed async ingest) must not be mistaken for "still running" — the
    // documented fallback is deliberate and must still fire once C1/C2 are fixed.
    let step = 0;
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      step++;
      if ((init?.method ?? "GET") === "POST") {
        if (step === 1) {
          return new Response(
            JSON.stringify(
              askEnvelope({
                collection: "c1",
                status: "ingesting",
                pages_done: 0,
                pages_total: 1,
                retry_after: 0,
              }),
            ),
            { status: 202 },
          );
        }
        return new Response(
          JSON.stringify(
            askEnvelope({
              collection: "c1",
              expires_at: "2026-09-01T00:00:00.000Z",
              matched: true,
              chunks: [],
            }),
          ),
          { status: 200 },
        );
      }
      // poll: no `job` key at all in data (not even `job: undefined` — genuinely absent)
      return new Response(
        JSON.stringify(
          statusEnvelope({
            collection: "c1",
            model: "@cf/baai/bge-m3",
            pages: 1,
            chunks: 2,
            created_at: "2026-08-01T00:00:00.000Z",
            expires_at: "2026-09-01T00:00:00.000Z",
          }),
        ),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const client = new AgentRag({
      accountKey: AK,
      endpoint,
      fetchImpl,
      maxRetries: 0,
    });

    const result = await client.askAndWait("what is x", {
      sources: ["https://a.com"],
      pollIntervalMs: 0,
      maxWaitMs: 5_000,
    });
    expect(result.matched).toBe(true);
    expect(step).toBe(3); // ask (202) -> one poll (absent job => terminal) -> re-ask
  });
});

describe("pollIngestJobState (askAndWait's internal poll helper)", () => {
  // Thin protected-access subclass, mirroring this repo's existing pattern
  // (spend-caps.test.ts / account-mode.test.ts) for driving a protected method directly.
  class PollTestClient extends AgentRag {
    poll(collection: string, jobId?: string) {
      return this.pollIngestJobState(collection, jobId);
    }
  }

  it("unwraps data.job (C2): a 'running' data.job is read correctly, not misread as absent", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify(
          statusEnvelope({
            collection: "c1",
            job: { pages_done: 1, pages_total: 4, state: "running" },
          }),
        ),
        { status: 200 },
      )) as unknown as typeof fetch;
    const client = new PollTestClient({ accountKey: AK, endpoint, fetchImpl });

    expect(await client.poll("c1")).toBe("running");
  });

  it("regenerates identity headers on EVERY retry attempt, not just the first (I2)", async () => {
    let signCount = 0;
    const spy = {
      ...signer,
      signTypedData: (async (args: Parameters<typeof signer.signTypedData>[0]) => {
        signCount++;
        return signer.signTypedData(args);
      }) as typeof signer.signTypedData,
    } as typeof signer;

    let attempt = 0;
    const fetchImpl = (async () => {
      attempt++;
      // Transient failure on the first attempt so core's fetchWithRetry retries — build()
      // is re-invoked per attempt (verified against core/src/retry.ts), so a correctly
      // fixed pollIngestJobState must sign again on the second attempt.
      if (attempt === 1) return new Response("{}", { status: 503 });
      return new Response(
        JSON.stringify(
          statusEnvelope({
            collection: "c1",
            job: { pages_done: 1, pages_total: 1, state: "complete" },
          }),
        ),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const client = new PollTestClient({
      signer: spy,
      endpoint,
      fetchImpl,
      maxRetries: 1,
    });

    const state = await client.poll("c1");
    expect(state).toBe("complete");
    expect(attempt).toBe(2); // proves a retry genuinely happened
    expect(signCount).toBe(2); // proves headers (and the identity signature) were recomputed per attempt, not cached from the first
  });

  it("account-key mode never signs (no signer needed) across a retry either", async () => {
    let attempt = 0;
    const fetchImpl = (async () => {
      attempt++;
      if (attempt === 1) return new Response("{}", { status: 503 });
      return new Response(
        JSON.stringify(
          statusEnvelope({
            collection: "c1",
            job: { pages_done: 1, pages_total: 1, state: "complete" },
          }),
        ),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const client = new PollTestClient({
      accountKey: AK,
      endpoint,
      fetchImpl,
      maxRetries: 1,
    });

    expect(await client.poll("c1")).toBe("complete");
    expect(attempt).toBe(2);
  });

  it("reads the NAMED job out of jobs[], not the display job", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify(
          statusEnvelope({
            collection: "c1",
            job: {
              job_id: "job_sibling",
              pages_done: 7,
              pages_total: 7,
              state: "complete",
            },
            jobs: [
              {
                job_id: "job_sibling",
                pages_done: 7,
                pages_total: 7,
                state: "complete",
              },
              {
                job_id: "job_mine",
                pages_done: 1,
                pages_total: 4,
                state: "running",
              },
            ],
          }),
        ),
        { status: 200 },
      )) as unknown as typeof fetch;
    const client = new PollTestClient({ accountKey: AK, endpoint, fetchImpl });

    expect(await client.poll("c1", "job_mine")).toBe("running");
    expect(await client.poll("c1", "job_sibling")).toBe("complete");
    // No id: the display job, exactly as before jobs carried ids.
    expect(await client.poll("c1")).toBe("complete");
    // A named job absent from a jobs[] that IS present reads as terminal, never "running":
    // the service never evicts a running row, so an id missing from that list is a job that
    // finished and aged out (or whose row was never written) — and calling it "running"
    // would hang the wait on a job nobody will report progress for again.
    expect(await client.poll("c1", "job_vanished")).toBeUndefined();
  });

  it("falls back to the display job when the service sends no jobs[] at all", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify(
          statusEnvelope({
            collection: "c1",
            job: { pages_done: 1, pages_total: 4, state: "running" },
          }),
        ),
        { status: 200 },
      )) as unknown as typeof fetch;
    const client = new PollTestClient({ accountKey: AK, endpoint, fetchImpl });

    // An older deployment names no jobs; a newer client must keep reading the one job it
    // does report rather than wait on an array that is never going to arrive.
    expect(await client.poll("c1", "job_mine")).toBe("running");
  });
});

describe("askAndWait: pins the job its own 202 named", () => {
  it("keeps waiting when a concurrent sibling completes first, and re-asks only once its OWN job is done", async () => {
    let askPosts = 0;
    let statusReads = 0;
    const sibling = {
      job_id: "job_sibling",
      pages_done: 7,
      pages_total: 7,
      state: "complete",
    };
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "POST") {
        askPosts++;
        if (askPosts === 1) {
          return new Response(
            JSON.stringify(
              askEnvelope({
                collection: "c12",
                status: "ingesting",
                job_id: "job_mine",
                pages_done: 0,
                pages_total: 3,
                retry_after: 0,
              }),
            ),
            { status: 202 },
          );
        }
        // The re-ask, issued only once THIS call's own ingest is done.
        return new Response(
          JSON.stringify(
            askEnvelope({
              collection: "c12",
              expires_at: "2026-09-01T00:00:00.000Z",
              matched: true,
              chunks: [
                {
                  text: "final",
                  score: 0.9,
                  url: null,
                  title: null,
                  position: 0,
                },
              ],
            }),
          ),
          { status: 200 },
        );
      }
      statusReads++;
      const mine = {
        job_id: "job_mine",
        pages_done: statusReads >= 2 ? 3 : 1,
        pages_total: 3,
        state: statusReads >= 2 ? "complete" : "running",
      };
      return new Response(
        JSON.stringify(
          statusEnvelope({
            collection: "c12",
            model: "@cf/baai/bge-m3",
            pages: 10,
            chunks: 20,
            created_at: "2026-08-01T00:00:00.000Z",
            expires_at: "2026-09-01T00:00:00.000Z",
            // The sibling is what the collection DISPLAYS, and it is already complete.
            job: sibling,
            jobs: [sibling, mine],
          }),
        ),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const client = new AgentRag({ accountKey: AK, endpoint, fetchImpl });

    const result = await client.askAndWait("what is x", {
      sources: ["https://a.com"],
      pollIntervalMs: 0,
      maxWaitMs: 5_000,
    });

    expect(result.chunks).toHaveLength(1);
    // Reading the display job would have re-asked after the FIRST poll, answering from a
    // collection this call's own ingest had not finished filling.
    expect(statusReads).toBe(2);
    expect(askPosts).toBe(2);
  });
});
