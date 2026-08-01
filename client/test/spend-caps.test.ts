import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { AgentRag, SpendCapError } from "../src/index";
import { askAuthorizedCeilingUsd } from "../src/pricing";

const endpoint = "https://rag.example";
const signer = privateKeyToAccount(generatePrivateKey());
// No sources -> the flat ask price ($0.008). Computed via the real formula (not the raw
// constant) so this suite also exercises pricing.ts, not just the ledger/ceiling wiring.
const ASK_CEILING = askAuthorizedCeilingUsd(undefined, 20);

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

// No ask()/ingest()/extend() exist yet, so tests drive performOp directly with an
// ask-shaped spec — exactly what a future `ask()` will hand it (same authorizedCeilingUsd
// formula, same Idempotency-Key discipline). Named `syntheticAsk`, not `ask`, so it never
// collides with the real verb method a later task adds to AgentRag itself.
class TestClient extends AgentRag {
  syntheticAsk(
    idempotencyKey: string,
    authorizedCeilingUsd = ASK_CEILING,
  ): Promise<{ collection: string }> {
    return this.performOp<{ collection: string }>({
      method: "POST",
      path: "/v1/rag/ask",
      url: `${this.endpoint}/v1/rag/ask`,
      idempotencyKey,
      label: "ask failed",
      authorizedCeilingUsd,
      buildRequest: (headers) => ({
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ query: "hi" }),
      }),
      parseSuccess: async (res) => JSON.parse(await res.text()),
    });
  }
}

// Spy on the signer so a test can assert a signature was never PRODUCED — not merely never
// SENT. `signed` (a sent PAYMENT-SIGNATURE header) stays false even if code signed and
// then failed to send, so it can't catch a sign-before-check reorder; `produced` counts
// the actual EIP-712 signing. The positive tests assert produced()===1 to prove the spy
// really observes signing.
function walletWith(opts: Record<string, unknown>, responses: Array<() => Response>) {
  let i = 0,
    signed = false,
    produced = 0;
  const spy = {
    ...signer,
    signTypedData: ((typedData: Parameters<typeof signer.signTypedData>[0]) => {
      produced++;
      return signer.signTypedData(typedData);
    }) as typeof signer.signTypedData,
  } as typeof signer;
  const fetchImpl = (async (_u: any, init?: RequestInit) => {
    if (init && new Headers(init.headers).get("PAYMENT-SIGNATURE")) signed = true;
    return responses[Math.min(i++, responses.length - 1)]();
  }) as unknown as typeof fetch;
  return {
    client: new TestClient({ signer: spy, endpoint, fetchImpl, ...opts }),
    signed: () => signed,
    produced: () => produced,
  };
}

describe("spend caps", () => {
  it("pre-sign: a challenge over maxSpendUsd throws SpendCapError, NO signature produced", async () => {
    // 8000 atomic = $0.008 = ASK_CEILING exactly, so the authorized-ceiling check PASSES —
    // this is the SEPARATE, downstream per-call cap ($0.001) that must still refuse it.
    const { client, signed, produced } = walletWith({ maxSpendUsd: 0.001 }, [
      () =>
        new Response("{}", {
          status: 402,
          headers: { "PAYMENT-REQUIRED": challenge("8000") },
        }),
    ]);
    await expect(client.syntheticAsk("k1")).rejects.toBeInstanceOf(SpendCapError);
    expect(signed()).toBe(false);
    expect(produced()).toBe(0); // no signature was ever produced, not merely unsent
  });

  // --- Authorized-ceiling guard: the primary defense, active even with NO maxSpendUsd set (default). ---

  it("DEFAULT config (no maxSpendUsd): a 402 quoting far above the base price is REFUSED, no signature", async () => {
    // Headline wallet-drain guard: a plain ask (base $0.008) whose 402 quotes $1.00 must be
    // refused before signing, even though no explicit cap is configured.
    const { client, signed, produced } = walletWith({}, [
      () =>
        new Response("{}", {
          status: 402,
          headers: { "PAYMENT-REQUIRED": challenge("1000000") },
        }), // $1.00
    ]);
    await expect(client.syntheticAsk("k1")).rejects.toBeInstanceOf(SpendCapError);
    expect(signed()).toBe(false);
    expect(produced()).toBe(0);
  });

  it("no maxSpendUsd: an HONEST quote at exactly the base price is signed (guard does not false-reject)", async () => {
    // 8000 atomic = $0.008 = ASK_BASE_USD exactly. This must stay pinned to the REAL
    // rag:ask price: it is the regression that catches a client base pinned below the
    // server's quote, which would make the authorized-ceiling guard refuse every honest ask.
    const { client, signed, produced } = walletWith({}, [
      () =>
        new Response("{}", {
          status: 402,
          headers: { "PAYMENT-REQUIRED": challenge("8000") },
        }),
      () =>
        new Response(JSON.stringify({ collection: "c1", matched: true, chunks: [] }), {
          status: 200,
        }),
    ]);
    const r = await client.syntheticAsk("k1");
    expect(r.collection).toBe("c1");
    expect(signed()).toBe(true);
    expect(produced()).toBe(1); // proves the signer spy actually observes signing
  });

  it("maxSessionSpendUsd $0.009: first paid ask resolves, second is refused at the cap BEFORE signing (one signature total)", async () => {
    // Cap $0.009; each ask is base $0.008. After the first ($0.008 spent), a second
    // ($0.008 more) would push cumulative to $0.016 > $0.009 — refused at the session-cap
    // check, after its probe 402 but BEFORE any signature. Fetch script: probe->402,
    // retry->200, probe->402.
    let sigCount = 0;
    let i = 0;
    const responses: Array<() => Response> = [
      () =>
        new Response("{}", {
          status: 402,
          headers: { "PAYMENT-REQUIRED": challenge("8000") },
        }),
      () =>
        new Response(JSON.stringify({ collection: "c1", matched: true, chunks: [] }), {
          status: 200,
        }),
      () =>
        new Response("{}", {
          status: 402,
          headers: { "PAYMENT-REQUIRED": challenge("8000") },
        }),
    ];
    const fetchImpl = (async (_u: any, init?: RequestInit) => {
      if (init && new Headers(init.headers).get("PAYMENT-SIGNATURE")) sigCount++;
      return responses[Math.min(i++, responses.length - 1)]();
    }) as unknown as typeof fetch;
    const client = new TestClient({
      signer,
      endpoint,
      fetchImpl,
      maxSessionSpendUsd: 0.009,
    });

    const first = await client.syntheticAsk("k1");
    expect(first.collection).toBe("c1");
    await expect(client.syntheticAsk("k2")).rejects.toBeInstanceOf(SpendCapError);
    expect(sigCount).toBe(1); // only the first ask ever signed; the second stopped at the cap
  });

  it("maxSessionSpendUsd $0.009 bounds CONCURRENT asks, not just sequential (reservation, not stale counter)", async () => {
    // Cap $0.009 with three PARALLEL asks at base $0.008: exactly one fits. `recordSpend`
    // only runs after the paid round-trip, so without a synchronous reservation all three
    // would check `0 + 0.008 <= 0.009` against the same stale counter, all pass, and all
    // SIGN — $0.024 of real EIP-3009 authorizations against a $0.009 cap.
    //
    // Can't reuse `walletWith`: its ordered response script assumes ops run one at a time,
    // so interleaved probes would consume each other's scripted replies. Key off the header
    // instead.
    let produced = 0;
    const spy = {
      ...signer,
      signTypedData: ((typedData: Parameters<typeof signer.signTypedData>[0]) => {
        produced++;
        return signer.signTypedData(typedData);
      }) as typeof signer.signTypedData,
    } as typeof signer;
    const fetchImpl = (async (_u: any, init?: RequestInit) => {
      if (!(init && new Headers(init.headers).get("PAYMENT-SIGNATURE"))) {
        return new Response("{}", {
          status: 402,
          headers: { "PAYMENT-REQUIRED": challenge("8000") },
        });
      }
      // Yield so every concurrent op is genuinely in flight across an await boundary — the
      // window in which a stale-counter check would let a sibling through.
      await new Promise((r) => setTimeout(r, 0));
      return new Response(JSON.stringify({ collection: "c1", matched: true, chunks: [] }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const client = new TestClient({
      signer: spy,
      endpoint,
      fetchImpl,
      maxSessionSpendUsd: 0.009,
    });

    const results = await Promise.allSettled([
      client.syntheticAsk("k1"),
      client.syntheticAsk("k2"),
      client.syntheticAsk("k3"),
    ]);
    const paid = results.filter((r) => r.status === "fulfilled").length;
    const capped = results.filter(
      (r) => r.status === "rejected" && r.reason instanceof SpendCapError,
    ).length;

    // Exact, not an upper bound: toBeLessThanOrEqual(1) would also pass if the reservation
    // over-counted so badly that NOTHING got through. Pin the right answer ($0.008 <=
    // $0.009; a second $0.008 breaches). `produced` is the load-bearing one — it counts
    // signatures actually PRODUCED, so it catches a sign-then-fail-to-send reorder that
    // `paid` cannot.
    expect(produced).toBe(1);
    expect(paid).toBe(1);
    expect(capped).toBe(2);
  });

  it("sequential spend is unchanged: two asks under a $0.020 cap both pay (reservation is released)", async () => {
    // Guards the other half of the reservation: a leaked (never released) reservation
    // would permanently consume budget and starve legitimate sequential ops. Two $0.008
    // asks must still fit a $0.020 cap, which they only do if the first op's reservation
    // was released and replaced by its $0.008 settled spend rather than double-counting.
    let sigCount = 0;
    const fetchImpl = (async (_u: any, init?: RequestInit) => {
      if (!(init && new Headers(init.headers).get("PAYMENT-SIGNATURE"))) {
        return new Response("{}", {
          status: 402,
          headers: { "PAYMENT-REQUIRED": challenge("8000") },
        });
      }
      sigCount++;
      return new Response(JSON.stringify({ collection: "c1", matched: true, chunks: [] }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const client = new TestClient({
      signer,
      endpoint,
      fetchImpl,
      maxSessionSpendUsd: 0.02,
    });

    expect((await client.syntheticAsk("k1")).collection).toBe("c1");
    expect((await client.syntheticAsk("k2")).collection).toBe("c1");
    expect(sigCount).toBe(2);
    // A third would push cumulative to $0.024 > $0.02 — still refused.
    await expect(client.syntheticAsk("k3")).rejects.toBeInstanceOf(SpendCapError);
    expect(sigCount).toBe(2);
  });

  it("a FAILED paid op releases its reservation without charging the session cap", async () => {
    // The `finally` half: when the paid retry comes back non-ok, `recordSpend` never runs,
    // so the reservation must be released or the budget is burned by an op that was never
    // charged. A $0.009 cap admits exactly one $0.008 ask; after a failed one, the next
    // must still fit.
    let attempt = 0;
    const fetchImpl = (async (_u: any, init?: RequestInit) => {
      if (!(init && new Headers(init.headers).get("PAYMENT-SIGNATURE"))) {
        return new Response("{}", {
          status: 402,
          headers: { "PAYMENT-REQUIRED": challenge("8000") },
        });
      }
      // First paid attempt fails upstream (nothing settles); the second succeeds.
      if (++attempt === 1) {
        return new Response(JSON.stringify({ error: "upstream", code: "internal_error" }), {
          status: 503,
        });
      }
      return new Response(JSON.stringify({ collection: "c1", matched: true, chunks: [] }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const client = new TestClient({
      signer,
      endpoint,
      fetchImpl,
      // maxRetries: 0 so the 503 surfaces instead of being retried away by the transport layer.
      maxRetries: 0,
      maxSessionSpendUsd: 0.009,
    });

    await expect(client.syntheticAsk("k1")).rejects.toMatchObject({
      code: "internal_error",
    });
    // The failed op charged nothing, so the cap still has room for a full $0.008 ask.
    expect((await client.syntheticAsk("k2")).collection).toBe("c1");
  });

  // --- Fail-CLOSED comparison polarity (defense in depth at the signing choke point) ---
  //
  // White-box on purpose. These guards are the last gates before a signature, so a
  // non-finite amount must be REFUSED rather than waved through by a vacuous `NaN > cap`
  // (always false). No PUBLIC input can produce a NaN here today — caps are validated at
  // construction and `@agentx402-ai/core` pins the challenge amount to /^[0-9]+$/ — so the
  // protected guards are driven directly. The point is that they stay safe if a future
  // call path ever loses that guarantee; a guard whose safety depends on a caller three
  // layers up is not a guard.
  class Probe extends AgentRag {
    spend(usd: number) {
      this.assertSpend(usd);
    }
    opCeiling(usd: number) {
      this.assertOpPriceCeiling(usd);
    }
  }

  it("assertSpend fails CLOSED on a non-finite amount vs the per-call cap", () => {
    const p = new Probe({ signer, endpoint, maxSpendUsd: 0.01 });
    expect(() => p.spend(Number.NaN)).toThrow(SpendCapError);
    expect(() => p.spend(Number.POSITIVE_INFINITY)).toThrow(SpendCapError);
    expect(() => p.spend(0.008)).not.toThrow(); // an honest amount still passes
  });

  it("assertSpend fails CLOSED on a non-finite amount vs the session cap", () => {
    const p = new Probe({ signer, endpoint, maxSessionSpendUsd: 0.01 });
    expect(() => p.spend(Number.NaN)).toThrow(SpendCapError);
  });

  it("assertOpPriceCeiling fails CLOSED on a non-finite quote in the default config", () => {
    const p = new Probe({ signer, endpoint });
    expect(() => p.opCeiling(Number.NaN)).toThrow(SpendCapError);
    expect(() => p.opCeiling(0.008)).not.toThrow();
  });
});
