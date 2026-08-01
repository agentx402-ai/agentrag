import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import { AgentRag, SpendCapError } from "../src/index";
import { extendAuthorizedCeilingUsd, usdToAtomic } from "../src/pricing";

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
          resource: "/v1/rag/extend",
          description: "extend",
          mimeType: "application/json",
          maxTimeoutSeconds: 300,
        },
      ],
    }),
  );
}

/** A worker-shaped extend 200 envelope: `{data: {...}, usage?, request_id?}`. */
function extendEnvelope(
  data: Record<string, unknown>,
  extra: { usage?: unknown; request_id?: string } = {},
) {
  return { data, ...extra };
}

/**
 * A worker-shaped collection-status 200 response, for wallet-mode `extend()`'s own pre-flight
 * `status()` call (the block-size guard — see extend()'s doc comment). `chunks` defaults well
 * under `CHUNKS_PER_BLOCK` so the guard never fires and these tests keep exercising whatever
 * they were written for; tests of the guard itself pass a larger `chunks`.
 */
function statusResponse(chunks = 0): Response {
  return new Response(
    JSON.stringify({
      data: {
        collection: "c1",
        model: "@cf/baai/bge-m3",
        pages: 1,
        chunks,
        created_at: "2026-08-01T00:00:00.000Z",
        expires_at: "2026-09-01T00:00:00.000Z",
      },
    }),
    { status: 200 },
  );
}

/**
 * A signer spy whose `paymentsProduced()` counts ONLY EIP-3009 payment authorizations
 * (`primaryType: "TransferWithAuthorization"`) — distinct from the FREE EIP-712 identity
 * signature extend()'s own pre-flight `status()` call legitimately produces first
 * (`primaryType: "Request"`). Both go through the same `signTypedData`, so a plain call
 * counter can't tell "no payment was produced" from "no signature at all was produced" —
 * conflating them is exactly what made the guard tests below fail for the wrong reason
 * when the pre-flight status() call was added.
 */
function paymentSigner() {
  let paymentsProduced = 0;
  const spy = {
    ...signer,
    signTypedData: (async (args: Parameters<typeof signer.signTypedData>[0]) => {
      if (args.primaryType === "TransferWithAuthorization") paymentsProduced++;
      return signer.signTypedData(args);
    }) as typeof signer.signTypedData,
  } as typeof signer;
  return { spy, paymentsProduced: () => paymentsProduced };
}

describe("extend: client-side validation runs BEFORE any request", () => {
  it("days: 45 throws invalid_request with NO request issued", async () => {
    const fetchImpl = vi.fn();
    const client = new AgentRag({
      accountKey: AK,
      endpoint,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    // @ts-expect-error deliberately invalid days, simulating an untyped caller
    await expect(client.extend("c1", 45)).rejects.toMatchObject({
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
    await expect(client.extend("", 30)).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("extend: happy path (envelope-wrapped fixtures)", () => {
  it("a valid extend sends {collection, days} and returns the new expires_at", async () => {
    let sentBody: Record<string, unknown> | undefined;
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      sentBody = JSON.parse(init?.body as string);
      return new Response(
        JSON.stringify(
          extendEnvelope(
            { collection: "c1", expires_at: "2026-10-01T00:00:00.000Z" },
            {
              usage: {
                service: "rag",
                op: "extend",
                price_usd: 0.01,
                list_price_usd: 0.01,
                credits_charged: 0,
              },
              request_id: "r1",
            },
          ),
        ),
        { status: 200, headers: { "X-AgentKV-Credits-Remaining": "5" } },
      );
    }) as unknown as typeof fetch;
    const client = new AgentRag({ accountKey: AK, endpoint, fetchImpl });

    const result = await client.extend("c1", 30);
    expect(sentBody).toEqual({ collection: "c1", days: 30 });
    expect(result.collection).toBe("c1");
    expect(result.expires_at).toBe("2026-10-01T00:00:00.000Z");
    expect(result.creditsRemaining).toBe(5);
    expect(result.request_id).toBe("r1");
    expect(result.settledTxHash).toBe("");
  });

  it("account-key mode issues exactly ONE bearer request, never probes", async () => {
    const calls: RequestInit[] = [];
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      calls.push(init ?? {});
      return new Response(
        JSON.stringify(
          extendEnvelope({
            collection: "c1",
            expires_at: "2026-10-01T00:00:00.000Z",
          }),
        ),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const client = new AgentRag({ accountKey: AK, endpoint, fetchImpl });

    await client.extend("c1", 60);
    expect(calls).toHaveLength(1);
    expect(new Headers(calls[0]?.headers).get("Authorization")).toBe(`Bearer ${AK}`);
  });
});

describe("extend: authorized ceiling (money-safety)", () => {
  it("a challenge quoting more than the 1-block ceiling is refused BEFORE signing", async () => {
    // paymentsProduced counts ONLY the EIP-3009 payment signature (primaryType
    // "TransferWithAuthorization"), not the free identity signature extend()'s own
    // pre-flight status() call legitimately produces first — see paymentSigner() below.
    const { spy, paymentsProduced } = paymentSigner();
    const ceiling = extendAuthorizedCeilingUsd(30);
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") return statusResponse(); // extend()'s pre-flight status() call
      return new Response("{}", {
        status: 402,
        headers: {
          "PAYMENT-REQUIRED": challenge(String(usdToAtomic(ceiling + 0.01))),
        },
      });
    }) as unknown as typeof fetch;
    const client = new AgentRag({ signer: spy, endpoint, fetchImpl });

    await expect(client.extend("c1", 30)).rejects.toBeInstanceOf(SpendCapError);
    expect(paymentsProduced()).toBe(0); // no PAYMENT signature was ever produced, not merely unsent
  });

  it("an honest quote at the ceiling is signed (the guard does not false-reject its own ceiling)", async () => {
    let signed = false;
    const ceiling = extendAuthorizedCeilingUsd(90);
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") return statusResponse(); // extend()'s pre-flight status() call
      if (init && new Headers(init.headers).get("PAYMENT-SIGNATURE")) {
        signed = true;
        return new Response(
          JSON.stringify(
            extendEnvelope({
              collection: "c1",
              expires_at: "2026-12-01T00:00:00.000Z",
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

    const result = await client.extend("c1", 90);
    expect(signed).toBe(true);
    expect(result.expires_at).toBe("2026-12-01T00:00:00.000Z");
  });
});

// The Critical this closes: the worker's pre-auth 402 for extend is deliberately stateless
// (always quoting the 1-block price, so an unauthenticated probe can't be a collection-size
// oracle), and a wallet-mode signature can never exceed what the challenge quoted — so a
// collection needing more than one block can NEVER be extended via a single wallet-mode call,
// no matter how the ceiling is computed. extend() must refuse BEFORE any probe/signature, not
// attempt a signed authorization that is provably short.
describe("extend: wallet-mode block-size guard (money-safety)", () => {
  it("a 12,000-chunk collection (3 blocks) refuses BEFORE any probe or signature", async () => {
    // status() itself DOES produce a free identity signature — paymentsProduced counts only
    // the (never-reached) EIP-3009 payment authorization. See paymentSigner()'s own comment.
    const { spy, paymentsProduced } = paymentSigner();
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return statusResponse(12_000);
    }) as unknown as typeof fetch;
    const client = new AgentRag({ signer: spy, endpoint, fetchImpl });

    await expect(client.extend("big-collection", 60)).rejects.toMatchObject({
      code: "extend_too_large_for_wallet_mode",
    });
    expect(calls).toBe(1); // only the status() read — no bare probe, no 402, no payment signature
    expect(paymentsProduced()).toBe(0);
  });

  it("exactly 5,000 chunks (the 1-block boundary) does NOT refuse", async () => {
    // Fencepost check: CHUNKS_PER_BLOCK itself must round DOWN to 1 block, not up to 2 — a
    // boundary bug here would wrongly refuse every collection sitting exactly at the limit.
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") return statusResponse(5_000);
      if (init && new Headers(init.headers).get("PAYMENT-SIGNATURE")) {
        return new Response(
          JSON.stringify(
            extendEnvelope({
              collection: "c1",
              expires_at: "2026-12-01T00:00:00.000Z",
            }),
          ),
          { status: 200 },
        );
      }
      return new Response("{}", {
        status: 402,
        headers: {
          "PAYMENT-REQUIRED": challenge(String(usdToAtomic(extendAuthorizedCeilingUsd(30, 5_000)))),
        },
      });
    }) as unknown as typeof fetch;
    const client = new AgentRag({ signer, endpoint, fetchImpl });

    const result = await client.extend("c1", 30);
    expect(result.expires_at).toBe("2026-12-01T00:00:00.000Z");
  });

  it("5,001 chunks (one over the boundary) refuses", async () => {
    const fetchImpl = (async () => statusResponse(5_001)) as unknown as typeof fetch;
    const client = new AgentRag({ signer, endpoint, fetchImpl });

    await expect(client.extend("c1", 30)).rejects.toMatchObject({
      code: "extend_too_large_for_wallet_mode",
    });
  });

  it("account-key mode succeeds on the same 12,000-chunk collection with exactly ONE bearer request (no status() call, no guard)", async () => {
    const calls: RequestInit[] = [];
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      calls.push(init ?? {});
      return new Response(
        JSON.stringify(
          extendEnvelope({
            collection: "big-collection",
            expires_at: "2026-12-01T00:00:00.000Z",
          }),
        ),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const client = new AgentRag({ accountKey: AK, endpoint, fetchImpl });

    // No status() call means the client has no idea this collection has 12,000 chunks — the
    // worker debits the real per-block price directly and this call still succeeds, unlike
    // the wallet-mode case above.
    const result = await client.extend("big-collection", 60);
    expect(result.collection).toBe("big-collection");
    expect(calls).toHaveLength(1);
    expect(new Headers(calls[0]?.headers).get("Authorization")).toBe(`Bearer ${AK}`);
  });
});
