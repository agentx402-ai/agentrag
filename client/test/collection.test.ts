import { chainIdFromCaip2, EIP712_DOMAIN_NAME, EIP712_DOMAIN_VERSION } from "@agentx402-ai/core";
import { recoverTypedDataAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import { AgentRag } from "../src/index";

const endpoint = "https://rag.example";
const signer = privateKeyToAccount(generatePrivateKey());
const AK = `ak_${"a".repeat(64)}`;
const HOST = new URL(endpoint).host;
const NETWORK = "eip155:8453"; // AgentRag's own DEFAULT_NETWORK

/** A worker-shaped collection-status 200 envelope (free route: no `usage`). */
function statusEnvelope(data: Record<string, unknown>, requestId = "r-status") {
  return { data, request_id: requestId };
}

function errorResponse(code: string, status: number, error = "err"): Response {
  return new Response(JSON.stringify({ error, code }), { status });
}

// Mirrors core's own (unexported — payment.ts never re-exports it) EIP-712 "Request" typed
// data shape, reconstructed here so this file can cryptographically RECOVER the signer from
// a captured signature rather than merely asserting a signature-shaped header exists. This
// is the mutation-proofing the review asked for: reverting `identityOrBearerHeaders` to a
// hardcoded `method: "GET"` still produces truthy X-AgentKV-* headers (the prior assertions
// stayed green under that mutation), but it signs a DIFFERENT message than a real DELETE
// would — recovering with the EXPECTED method against the ACTUAL signature only yields the
// signer's own address when the two agree.
const REQUEST_TYPES = {
  Request: [
    { name: "method", type: "string" },
    { name: "path", type: "string" },
    { name: "host", type: "string" },
    { name: "nonce", type: "bytes32" },
    { name: "timestamp", type: "uint256" },
  ],
} as const;

/**
 * Recovers the address that signed `headers` as an identity (EIP-712 "Request") header set,
 * reconstructing the typed data with the CALLER-SUPPLIED `method` (not read off the request
 * — that's the point: an expected method that disagrees with what was actually signed
 * recovers the WRONG address, not an exception, so the assertion is a plain equality check).
 */
async function recoverIdentitySigner(
  headers: Headers,
  method: "GET" | "DELETE",
  path: string,
): Promise<`0x${string}`> {
  const nonce = headers.get("X-AgentKV-Nonce");
  const timestamp = headers.get("X-AgentKV-Timestamp");
  const signature = headers.get("X-AgentKV-Signature");
  if (!nonce || !timestamp || !signature) {
    throw new Error("recoverIdentitySigner: missing identity header(s)");
  }
  return recoverTypedDataAddress({
    domain: {
      name: EIP712_DOMAIN_NAME,
      version: EIP712_DOMAIN_VERSION,
      chainId: chainIdFromCaip2(NETWORK),
    },
    types: REQUEST_TYPES,
    primaryType: "Request",
    message: {
      method,
      path,
      host: HOST,
      nonce: nonce as `0x${string}`,
      timestamp: BigInt(timestamp),
    },
    signature: signature as `0x${string}`,
  });
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
    // Cryptographic proof (not just a truthy header): recover the signer from the ACTUAL
    // signature, reconstructing the message with the EXPECTED method "GET". If the
    // implementation ever hardcoded (or reverted to) a wrong signed method, this recovers a
    // different address than `signer.address` — a truthy-header check alone cannot catch
    // that, since the mutation still emits all three headers.
    const recovered = await recoverIdentitySigner(
      seenHeaders as Headers,
      "GET",
      "/v1/rag/collection/c1",
    );
    expect(recovered.toLowerCase()).toBe(signer.address.toLowerCase());
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

  it("surfaces per-page failure reasons on the job block, so an empty collection explains itself", async () => {
    // The motivating case. Server-side, a job that failed every page still reports
    // pages_done === pages_total and state "complete" — a total failure wearing the shape
    // of a total success. These fields are the only thing that tells them apart, and
    // upstream_status_402 is the realistic reason: AgentRAG fetches through AgentScout
    // with NO toll budget, so a paywalled source fails closed rather than being paid for.
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
            job: {
              pages_done: 3,
              pages_total: 3,
              state: "complete",
              pages_ok: 0,
              pages_failed: 3,
              failures: [
                { url: "https://paywalled.test/a", reason: "upstream_status_402" },
                { url: "https://thin.test/b", reason: "thin_content" },
                { url: null, reason: "no_chunks" },
              ],
              stopped: "collection_full",
            },
          }),
        ),
        { status: 200 },
      )) as unknown as typeof fetch;
    const client = new AgentRag({ signer, endpoint, fetchImpl });

    const result = await client.status("c1");
    expect(result.job?.pages_ok).toBe(0);
    expect(result.job?.pages_failed).toBe(3);
    expect(result.job?.stopped).toBe("collection_full");
    // A null url (a document ingested without one) must survive rather than be dropped.
    expect(result.job?.failures).toEqual([
      { url: "https://paywalled.test/a", reason: "upstream_status_402" },
      { url: "https://thin.test/b", reason: "thin_content" },
      { url: null, reason: "no_chunks" },
    ]);
  });

  it("reports refunded_credits on a FAILED job, so a caller who paid can see they were made whole", async () => {
    // A job that dies after starting now refunds its unspent budget
    // automatically (worker issue #60). 5 charged, 1 indexed, 4 refunded at 50
    // credits each. Before that fix the caller kept the loss; before this
    // release they could not see the refund without reading their balance.
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify(
          statusEnvelope({
            collection: "c1",
            model: "@cf/baai/bge-m3",
            pages: 1,
            chunks: 4,
            created_at: "2026-08-01T00:00:00.000Z",
            expires_at: "2026-09-01T00:00:00.000Z",
            job: {
              pages_done: 1,
              pages_total: 5,
              state: "failed",
              pages_ok: 1,
              pages_failed: 0,
              refunded_credits: 200,
            },
          }),
        ),
        { status: 200 },
      )) as unknown as typeof fetch;
    const client = new AgentRag({ signer, endpoint, fetchImpl });

    const result = await client.status("c1");
    expect(result.job?.state).toBe("failed");
    expect(result.job?.refunded_credits).toBe(200);
  });

  it("distinguishes refunded_credits 0 from an older service that cannot say", async () => {
    // 0 means nothing was owed back. Absent means the service predates the
    // field. Collapsing them would tell a caller "you were refunded nothing"
    // when the truth is "unknown".
    const mk = (job: Record<string, unknown>) =>
      (async () =>
        new Response(
          JSON.stringify(
            statusEnvelope({
              collection: "c1",
              model: "@cf/baai/bge-m3",
              pages: 2,
              chunks: 8,
              created_at: "2026-08-01T00:00:00.000Z",
              expires_at: "2026-09-01T00:00:00.000Z",
              job,
            }),
          ),
          { status: 200 },
        )) as unknown as typeof fetch;

    const zero = await new AgentRag({
      signer,
      endpoint,
      fetchImpl: mk({ pages_done: 2, pages_total: 2, state: "complete", refunded_credits: 0 }),
    }).status("c1");
    expect(zero.job?.refunded_credits).toBe(0);

    const silent = await new AgentRag({
      signer,
      endpoint,
      fetchImpl: mk({ pages_done: 2, pages_total: 2, state: "complete" }),
    }).status("c1");
    expect(silent.job?.refunded_credits).toBeUndefined();
  });

  it("parses a PRE-detail job block unchanged — the fields are optional, not assumed", async () => {
    // Collections whose job row predates these fields are still live and there is no
    // migration for them. A client that assumed the fields would read `undefined` as 0
    // and report a clean run as a total failure, which is worse than saying nothing.
    const fetchImpl = (async () =>
      new Response(
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
      )) as unknown as typeof fetch;
    const client = new AgentRag({ signer, endpoint, fetchImpl });

    const result = await client.status("c1");
    expect(result.job).toEqual({ pages_done: 2, pages_total: 2, state: "complete" });
    expect(result.job?.pages_ok).toBeUndefined();
    expect(result.job?.failures).toBeUndefined();
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
    // Cryptographic proof, mirroring status()'s own — see that test's comment. Recovering
    // with the EXPECTED method "DELETE" only yields the signer's address if "DELETE" is
    // really what got signed, not merely what the caller intended.
    const recovered = await recoverIdentitySigner(
      seenHeaders as Headers,
      "DELETE",
      "/v1/rag/collection/c1",
    );
    expect(recovered.toLowerCase()).toBe(signer.address.toLowerCase());
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
