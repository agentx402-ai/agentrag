import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import { AgentRag } from "../src/index";

const endpoint = "https://rag.example";
const signer = privateKeyToAccount(generatePrivateKey());
const AK = `ak_${"a".repeat(64)}`;

/** A worker-shaped collection-status 200 envelope (free route: no `usage`). */
function statusEnvelope(data: Record<string, unknown>, requestId = "r-status") {
  return { data, request_id: requestId };
}

function errorResponse(code: string, status: number, error = "err"): Response {
  return new Response(JSON.stringify({ error, code }), { status });
}

describe("status(): client-side validation runs BEFORE any request", () => {
  it("an empty-string collection throws invalid_request with NO request issued", async () => {
    const fetchImpl = vi.fn();
    const client = new AgentRag({
      accountKey: AK,
      endpoint,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.status("")).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("status()", () => {
  it("signs with identity headers (wallet mode) and parses the job block", async () => {
    let seenHeaders: Headers | undefined;
    let seenMethod: string | undefined;
    let seenUrl: string | undefined;
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      seenHeaders = new Headers(init?.headers);
      seenMethod = init?.method;
      seenUrl = typeof input === "string" ? input : (input as Request).url;
      return new Response(
        JSON.stringify(
          statusEnvelope({
            collection: "c1",
            model: "@cf/baai/bge-m3",
            pages: 2,
            chunks: 8,
            created_at: "2026-08-01T00:00:00.000Z",
            expires_at: "2026-09-01T00:00:00.000Z",
            job: { pages_done: 2, pages_total: 2, state: "complete" },
          }),
        ),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const client = new AgentRag({ signer, endpoint, fetchImpl });

    const result = await client.status("c1");
    expect(seenMethod).toBe("GET");
    expect(seenUrl).toBe(`${endpoint}/v1/rag/collection/c1`);
    // The three identity headers this SDK's other identity-signed helper (buildIdentityHeaders,
    // via @agentx402-ai/core) is documented to emit — asserting the NAMES, per the brief.
    expect(seenHeaders?.get("X-AgentKV-Signature")).toBeTruthy();
    expect(seenHeaders?.get("X-AgentKV-Nonce")).toBeTruthy();
    expect(seenHeaders?.get("X-AgentKV-Timestamp")).toBeTruthy();
    expect(result).toMatchObject({
      collection: "c1",
      model: "@cf/baai/bge-m3",
      pages: 2,
      chunks: 8,
      created_at: "2026-08-01T00:00:00.000Z",
      expires_at: "2026-09-01T00:00:00.000Z",
      job: { pages_done: 2, pages_total: 2, state: "complete" },
      request_id: "r-status",
    });
  });

  it("a collection with no active job reports `job` as undefined, not misread as running", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify(
          statusEnvelope({
            collection: "c1",
            model: "@cf/baai/bge-m3",
            pages: 0,
            chunks: 0,
            created_at: "2026-08-01T00:00:00.000Z",
            expires_at: "2026-09-01T00:00:00.000Z",
          }),
        ),
        { status: 200 },
      )) as unknown as typeof fetch;
    const client = new AgentRag({ signer, endpoint, fetchImpl });

    const result = await client.status("c1");
    expect(result.job).toBeUndefined();
  });

  it("account-key mode sends a bearer header, not identity headers", async () => {
    const calls: RequestInit[] = [];
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      calls.push(init ?? {});
      return new Response(
        JSON.stringify(
          statusEnvelope({
            collection: "c1",
            model: "@cf/baai/bge-m3",
            pages: 0,
            chunks: 0,
            created_at: "2026-08-01T00:00:00.000Z",
            expires_at: "2026-09-01T00:00:00.000Z",
          }),
        ),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const client = new AgentRag({ accountKey: AK, endpoint, fetchImpl });

    await client.status("c1");
    expect(calls).toHaveLength(1);
    expect(new Headers(calls[0]?.headers).get("Authorization")).toBe(`Bearer ${AK}`);
    expect(new Headers(calls[0]?.headers).get("X-AgentKV-Signature")).toBeNull();
  });

  it("a 404 surfaces collection_not_found", async () => {
    const fetchImpl = (async () =>
      errorResponse(
        "collection_not_found",
        404,
        "collection not found",
      )) as unknown as typeof fetch;
    const client = new AgentRag({ accountKey: AK, endpoint, fetchImpl });

    await expect(client.status("missing")).rejects.toMatchObject({
      code: "collection_not_found",
    });
  });

  it("a 410 surfaces collection_expired", async () => {
    const fetchImpl = (async () =>
      errorResponse("collection_expired", 410, "collection expired")) as unknown as typeof fetch;
    const client = new AgentRag({ accountKey: AK, endpoint, fetchImpl });

    await expect(client.status("old")).rejects.toMatchObject({
      code: "collection_expired",
    });
  });
});

describe("delete(): client-side validation runs BEFORE any request", () => {
  it("an empty-string collection throws invalid_request with NO request issued", async () => {
    const fetchImpl = vi.fn();
    const client = new AgentRag({
      accountKey: AK,
      endpoint,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.delete("")).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("delete()", () => {
  it("issues a DELETE, signed with identity headers for the DELETE method (wallet mode)", async () => {
    let seenMethod: string | undefined;
    let seenHeaders: Headers | undefined;
    let seenUrl: string | undefined;
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      seenMethod = init?.method;
      seenHeaders = new Headers(init?.headers);
      seenUrl = typeof input === "string" ? input : (input as Request).url;
      return new Response(JSON.stringify(statusEnvelope({ deleted: true })), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const client = new AgentRag({ signer, endpoint, fetchImpl });

    const result = await client.delete("c1");
    expect(seenMethod).toBe("DELETE");
    expect(seenUrl).toBe(`${endpoint}/v1/rag/collection/c1`);
    expect(seenHeaders?.get("X-AgentKV-Signature")).toBeTruthy();
    expect(seenHeaders?.get("X-AgentKV-Nonce")).toBeTruthy();
    expect(seenHeaders?.get("X-AgentKV-Timestamp")).toBeTruthy();
    expect(result).toEqual({ deleted: true });
  });

  it("account-key mode sends a bearer header", async () => {
    const calls: RequestInit[] = [];
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      calls.push(init ?? {});
      return new Response(JSON.stringify(statusEnvelope({ deleted: true })), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const client = new AgentRag({ accountKey: AK, endpoint, fetchImpl });

    const result = await client.delete("c1");
    expect(calls).toHaveLength(1);
    expect(new Headers(calls[0]?.headers).get("Authorization")).toBe(`Bearer ${AK}`);
    expect(calls[0]?.method).toBe("DELETE");
    expect(result).toEqual({ deleted: true });
  });

  it("a 404 surfaces collection_not_found", async () => {
    const fetchImpl = (async () =>
      errorResponse(
        "collection_not_found",
        404,
        "collection not found",
      )) as unknown as typeof fetch;
    const client = new AgentRag({ accountKey: AK, endpoint, fetchImpl });

    await expect(client.delete("missing")).rejects.toMatchObject({
      code: "collection_not_found",
    });
  });

  it("a 410 surfaces collection_expired", async () => {
    const fetchImpl = (async () =>
      errorResponse("collection_expired", 410, "collection expired")) as unknown as typeof fetch;
    const client = new AgentRag({ accountKey: AK, endpoint, fetchImpl });

    await expect(client.delete("old")).rejects.toMatchObject({
      code: "collection_expired",
    });
  });
});
