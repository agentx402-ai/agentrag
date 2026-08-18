import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import { AgentRag, EXTEND_BLOCK_USD, MAX_CHUNKS, SpendCapError } from "../src/index";
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
 * `status()` call (it learns the real chunk count to pin the real signed amount — see
 * extend()'s doc comment). `chunks` defaults to a small value well under `CHUNKS_PER_BLOCK`
 * so tests not specifically about block size get the ordinary 1-block price.
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
 * A signer spy that captures the atomic `value` of every EIP-3009 payment authorization
 * (`primaryType: "TransferWithAuthorization"`) it signs — distinct from the FREE EIP-712
 * identity signature extend()'s own pre-flight `status()` call legitimately produces first
 * (`primaryType: "Request"`). Both go through the same `signTypedData`, so a plain call
 * counter can't tell "no payment was produced" from "no signature at all was produced", and
 * a plain COUNT can't prove which AMOUNT was actually signed — the whole point of this
 * round's fix is that it's the REAL computed amount, not the challenge's stateless quote.
 */
function paymentSigner() {
  const paymentAmounts: bigint[] = [];
  const spy = {
    ...signer,
    signTypedData: (async (args: Parameters<typeof signer.signTypedData>[0]) => {
      if (args.primaryType === "TransferWithAuthorization") {
        const message = args.message as { value: bigint };
        paymentAmounts.push(BigInt(message.value));
      }
      return signer.signTypedData(args);
    }) as typeof signer.signTypedData,
  } as typeof signer;
  return {
    spy,
    paymentsProduced: () => paymentAmounts.length,
    paymentAmounts: () => paymentAmounts,
  };
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

  it("passes a caller-supplied idempotencyKey through so a retried extend dedups (no double-charge)", async () => {
    // extend() had no idempotencyKey option, so a retry of a lost-but-settled extend used a
    // fresh nonce and double-charged. The key must reach the Idempotency-Key header verbatim.
    let sentKey: string | null = null;
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      sentKey = new Headers(init?.headers).get("Idempotency-Key");
      return new Response(
        JSON.stringify(
          extendEnvelope({ collection: "c1", expires_at: "2026-10-01T00:00:00.000Z" }),
        ),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const client = new AgentRag({ accountKey: AK, endpoint, fetchImpl });

    await client.extend("c1", 30, { idempotencyKey: "my-extend-key" });
    expect(sentKey).toBe("my-extend-key");
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
  it("a real extend that would exceed maxSpendUsd is refused BEFORE any payment signature", async () => {
    // The 402's own quote is irrelevant here (see the describe block below) — what must
    // still gate a real, correctly-priced multi-block extend is the caller's OWN configured
    // cap. 12,000 chunks -> 3 blocks; 60 days -> 2 units -> 6 units total -> $0.06. A
    // maxSpendUsd of $0.05 must refuse it, via the ordinary spend-cap path, not a ceiling
    // mismatch against the challenge.
    const { spy, paymentsProduced } = paymentSigner();
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") return statusResponse(12_000);
      return new Response("{}", {
        status: 402,
        headers: {
          "PAYMENT-REQUIRED": challenge(String(usdToAtomic(extendAuthorizedCeilingUsd(60)))),
        },
      });
    }) as unknown as typeof fetch;
    const client = new AgentRag({
      signer: spy,
      endpoint,
      fetchImpl,
      maxSpendUsd: 0.05,
    });

    await expect(client.extend("big-collection", 60)).rejects.toBeInstanceOf(SpendCapError);
    expect(paymentsProduced()).toBe(0); // no PAYMENT signature was ever produced, not merely unsent
  });

  it("an honest 1-block quote is signed (the guard does not false-reject its own ceiling)", async () => {
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
// oracle) — but extend is a genuine top-up-style route (the worker's own auth call for it
// passes `allowTopUp`), so a wallet-mode signature does NOT have to equal the challenge's
// quoted amount. extend() learns the real chunk count via status() and PINS the real
// computed price as the signed amount (`buildPaymentHeader`'s `amountAtomic` override),
// regardless of what the stateless challenge quoted. An earlier version of this fix assumed
// a signature could never exceed the challenge's amount and refused any multi-block extend
// outright — withdrawn: that assumption was wrong (see pricing.ts's own doc comment for the
// full trace). These tests assert the ACTUAL SIGNED AMOUNT, not merely success/failure, so a
// regression that silently reverted to signing the challenge's stateless quote would be
// caught even though the mocked "server" here doesn't itself validate the amount.
describe("extend: wallet-mode pins the real settle amount (money-safety)", () => {
  it("a 12,000-chunk collection (3 blocks, days 60) signs the real 6-unit amount, not the challenge's 1-block quote", async () => {
    const { spy, paymentAmounts } = paymentSigner();
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") return statusResponse(12_000);
      if (init && new Headers(init.headers).get("PAYMENT-SIGNATURE")) {
        return new Response(
          JSON.stringify(
            extendEnvelope({
              collection: "big-collection",
              expires_at: "2026-12-01T00:00:00.000Z",
            }),
          ),
          { status: 200 },
        );
      }
      // The stateless 1-block quote (60 days -> 2 units -> $0.02) — deliberately NOT the
      // real 6-unit ($0.06) price this collection actually needs.
      return new Response("{}", {
        status: 402,
        headers: {
          "PAYMENT-REQUIRED": challenge(String(usdToAtomic(extendAuthorizedCeilingUsd(60)))),
        },
      });
    }) as unknown as typeof fetch;
    const client = new AgentRag({ signer: spy, endpoint, fetchImpl });

    const result = await client.extend("big-collection", 60);
    expect(result.collection).toBe("big-collection");
    expect(paymentAmounts()).toHaveLength(1);
    // The REAL amount (3 blocks x 2 units x $0.01 = $0.06), not the challenge's $0.02.
    expect(paymentAmounts()[0]).toBe(BigInt(usdToAtomic(extendAuthorizedCeilingUsd(60, 12_000))));
    expect(paymentAmounts()[0]).not.toBe(BigInt(usdToAtomic(extendAuthorizedCeilingUsd(60))));
  });

  it("exactly 5,000 chunks (the 1-block boundary) signs the 1-block amount", async () => {
    // Fencepost check: CHUNKS_PER_BLOCK itself must round DOWN to 1 block, not up to 2.
    const { spy, paymentAmounts } = paymentSigner();
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
          "PAYMENT-REQUIRED": challenge(String(usdToAtomic(extendAuthorizedCeilingUsd(30)))),
        },
      });
    }) as unknown as typeof fetch;
    const client = new AgentRag({ signer: spy, endpoint, fetchImpl });

    const result = await client.extend("c1", 30);
    expect(result.expires_at).toBe("2026-12-01T00:00:00.000Z");
    expect(paymentAmounts()[0]).toBe(BigInt(usdToAtomic(extendAuthorizedCeilingUsd(30, 5_000))));
    expect(paymentAmounts()[0]).toBe(BigInt(usdToAtomic(extendAuthorizedCeilingUsd(30)))); // == the 1-block price
  });

  it("5,001 chunks (one over the boundary) signs the 2-block amount, not 1", async () => {
    const { spy, paymentAmounts } = paymentSigner();
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") return statusResponse(5_001);
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
          "PAYMENT-REQUIRED": challenge(String(usdToAtomic(extendAuthorizedCeilingUsd(30)))),
        },
      });
    }) as unknown as typeof fetch;
    const client = new AgentRag({ signer: spy, endpoint, fetchImpl });

    const result = await client.extend("c1", 30);
    expect(result.expires_at).toBe("2026-12-01T00:00:00.000Z");
    expect(paymentAmounts()[0]).toBe(BigInt(usdToAtomic(extendAuthorizedCeilingUsd(30, 5_001))));
    expect(paymentAmounts()[0]).not.toBe(BigInt(usdToAtomic(extendAuthorizedCeilingUsd(30)))); // != the 1-block price
  });

  it("account-key mode succeeds on the same 12,000-chunk collection with exactly ONE bearer request (no status() call, no signature at all)", async () => {
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

    // No status() call and no signature at all — the worker debits the real per-block price
    // directly from prepaid credits, which this SDK never needs to compute or pin.
    const result = await client.extend("big-collection", 60);
    expect(result.collection).toBe("big-collection");
    expect(calls).toHaveLength(1);
    expect(new Headers(calls[0]?.headers).get("Authorization")).toBe(`Bearer ${AK}`);
  });
});

// The Critical this closes: the ceiling passed to performOp must NOT be derived from the
// SAME server-supplied chunk count as the amount being signed, or the check degenerates to
// comparing a number against itself — always true, no matter how large or implausible that
// number is. A prior round of this fix (since withdrawn) did exactly that
// (`authorizedCeilingUsd: realAmountUsd` where `realAmountUsd` came from `status()`), and a
// reviewer demonstrated it signing an unbounded authorization at $2,000,000. The ceiling is
// now `maxExtendAmountUsd(days)` — a STRUCTURAL bound derived from the service's own
// MAX_CHUNKS cap, independent of any single response — so it can actually refuse.
describe("extend: structural ceiling clamps a server-supplied chunk count (money-safety)", () => {
  it("a chunk count implying an impossible collection (1,000,000, far past MAX_CHUNKS) refuses to sign", async () => {
    const { spy, paymentsProduced } = paymentSigner();
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") return statusResponse(1_000_000);
      return new Response("{}", {
        status: 402,
        headers: {
          "PAYMENT-REQUIRED": challenge(String(usdToAtomic(extendAuthorizedCeilingUsd(90)))),
        },
      });
    }) as unknown as typeof fetch;
    const client = new AgentRag({ signer: spy, endpoint, fetchImpl });

    await expect(client.extend("c1", 90)).rejects.toBeInstanceOf(SpendCapError);
    expect(paymentsProduced()).toBe(0); // no PAYMENT signature was ever produced, not merely unsent
  });

  it("one chunk OVER MAX_CHUNKS (25,001, implying 6 blocks — impossible for any real collection) refuses to sign", async () => {
    const { spy, paymentsProduced } = paymentSigner();
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") return statusResponse(MAX_CHUNKS + 1);
      return new Response("{}", {
        status: 402,
        headers: {
          "PAYMENT-REQUIRED": challenge(String(usdToAtomic(extendAuthorizedCeilingUsd(90)))),
        },
      });
    }) as unknown as typeof fetch;
    const client = new AgentRag({ signer: spy, endpoint, fetchImpl });

    await expect(client.extend("c1", 90)).rejects.toBeInstanceOf(SpendCapError);
    expect(paymentsProduced()).toBe(0);
  });

  it("exactly 25,000 chunks (MAX_CHUNKS) at 90 days — the true legitimate boundary — still succeeds", async () => {
    // Fencepost check in the OTHER direction from the two refusals above: the structural
    // ceiling must not be so tight that it rejects the largest collection the service
    // itself allows to exist. The chunk count (25,000) and the expected price (5 blocks x 3
    // units x $0.01) are both HARDCODED literals here, not re-derived via MAX_CHUNKS /
    // maxExtendAmountUsd — a mutation to either would otherwise shift this test's own
    // expectation right along with the code under test, so it would never notice (this is
    // exactly how a real MAX_CHUNKS-too-tight mutation slipped past this test on its first
    // draft, caught only incidentally by an unrelated test elsewhere in this file).
    const { spy, paymentAmounts } = paymentSigner();
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") return statusResponse(25_000);
      if (init && new Headers(init.headers).get("PAYMENT-SIGNATURE")) {
        return new Response(
          JSON.stringify(
            extendEnvelope({
              collection: "c1",
              expires_at: "2027-01-01T00:00:00.000Z",
            }),
          ),
          { status: 200 },
        );
      }
      return new Response("{}", {
        status: 402,
        headers: {
          "PAYMENT-REQUIRED": challenge(String(usdToAtomic(extendAuthorizedCeilingUsd(90)))),
        },
      });
    }) as unknown as typeof fetch;
    const client = new AgentRag({ signer: spy, endpoint, fetchImpl });

    const result = await client.extend("c1", 90);
    expect(result.expires_at).toBe("2027-01-01T00:00:00.000Z");
    expect(paymentAmounts()[0]).toBe(BigInt(usdToAtomic(5 * 3 * EXTEND_BLOCK_USD)));
  });
});
