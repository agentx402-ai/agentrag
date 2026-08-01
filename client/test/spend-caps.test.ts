import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { AgentRag, AgentRagError, DEFAULT_MAX_OP_USD, SpendCapError } from "../src/index";
import {
  askAuthorizedCeilingUsd,
  extendAuthorizedCeilingUsd,
  ingestAuthorizedCeilingUsd,
  usdToAtomic,
} from "../src/pricing";

const endpoint = "https://rag.example";
const signer = privateKeyToAccount(generatePrivateKey());
// No sources -> the flat ask price ($0.008). Computed via the real formula (not the raw
// constant) so this suite also exercises pricing.ts, not just the ledger/ceiling wiring.
const ASK_CEILING = askAuthorizedCeilingUsd(undefined, 20);

function challenge(amount: string, resource = "/v1/rag/ask"): string {
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
          resource,
          description: resource,
          mimeType: "application/json",
          maxTimeoutSeconds: 300,
        },
      ],
    }),
  );
}

// `ask()`/`ingest()`/`extend()` now exist (Tasks 5-6), but these performOp-level tests
// predate them and stay in this shape deliberately: they drive `performOp` directly with an
// ask-shaped spec through a synthetic subclass, so they keep covering the shared
// ceiling/reservation/release mechanism generically, independent of any one verb's own
// request/response shape. Named `syntheticAsk`, not `ask`, so it never collides with the
// real verb method on `AgentRag` itself. The "spend recording via the real verbs" describe
// block below this class additionally drives `ingest()`/`extend()` themselves, closing the
// coverage gap this comment used to describe honestly ("No ask()/ingest()/extend() exist
// yet") but no longer does.
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

  // Drives `performOp` with `authorizedCeilingUsd` OMITTED from the spec entirely (not
  // merely `undefined` passed positionally — `syntheticAsk`'s default parameter would mask
  // that). None of the three real verbs (ask/ingest/extend) ever omit it, so this is the
  // only way to reach the `else` branch in performOp's 402 handling: the DEFAULT_MAX_OP_USD
  // backstop via `assertOpPriceCeiling`, documented as "the ONLY guard for an op that
  // declares no authorizedCeilingUsd of its own".
  syntheticAskNoCeiling(idempotencyKey: string): Promise<{ collection: string }> {
    return this.performOp<{ collection: string }>({
      method: "POST",
      path: "/v1/rag/ask",
      url: `${this.endpoint}/v1/rag/ask`,
      idempotencyKey,
      label: "ask failed",
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
    reserve(usd: number) {
      return this.reserveSession(usd);
    }
    signerOrThrow() {
      return this.requireSigner();
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

  // `reserveSession` is a thin `this.ledger.reserve(usd)` wrapper that no production call
  // site uses today (performOp reserves via `assertAndReserveSpend`, the assert+reserve
  // combination, instead) — it exists as protected surface for a caller that already
  // asserted and only needs the reservation half. Proven here as a real reservation against
  // the SESSION cap (not a no-op): reserving pins the amount in flight, a concurrent
  // over-cap check is refused while it's outstanding, and releasing frees it back up.
  it("reserveSession reserves against the session cap; its release fn frees the reservation", () => {
    const p = new Probe({ signer, endpoint, maxSessionSpendUsd: 0.01 });
    const release = p.reserve(0.008);
    // 0.008 in flight + 0.005 more would breach the $0.01 cap.
    expect(() => p.spend(0.005)).toThrow(SpendCapError);
    release();
    // Idempotent: a second release must not hand budget back twice.
    release();
    // With the reservation freed, the identical $0.005 check now fits.
    expect(() => p.spend(0.005)).not.toThrow();
  });

  // `requireSigner` throwing is unreachable through the public constructor in WALLET mode
  // (one of `signer`/`privateKey` is required whenever `accountKey` is absent) — but
  // account-key mode legitimately constructs an instance with no `signer` at all, so this
  // drives the guard directly rather than depending on that invariant never being
  // accidentally weakened by a future refactor (the same "can't happen, test it anyway"
  // discipline as the comparison-polarity guards above).
  it("requireSigner throws invalid_config when no wallet signer is configured", () => {
    const p = new Probe({ accountKey: `ak_${"a".repeat(64)}`, endpoint });
    expect(() => p.signerOrThrow()).toThrow(AgentRagError);
    expect(() => p.signerOrThrow()).toThrow(/wallet signer is required/);
  });
});

// Review fix round 1 (Important #3): the tests above prove `performOp`'s ceiling/reservation
// mechanism generically, through a synthetic spec — but nothing exercised `recordSpend`
// through the REAL `ingest()`/`extend()` call sites, including ingest's 202 (its job path
// settles the charge BEFORE returning the 202 — see ingest.ts's own module doc — so
// `Response.ok` being true for a 202 is what makes `if (res.ok) this.recordSpend(usd)`
// correct there, unlike ask()'s 202, which precedes its own pay-on-success charge). A
// regression narrowing that condition (e.g. to `res.status === 200`) would silently stop
// counting every job-path ingest against `maxSessionSpendUsd` and the suite would stay
// green without this coverage.
//
// Same technique as the "second identical call is capped" tests above: set
// maxSessionSpendUsd to fit exactly ONE op's price, prove the first succeeds, then prove an
// IDENTICAL second call is refused at the cap — that refusal is only possible if the first
// call's settled amount actually moved the session counter.
describe("ingest()/extend(): spend recording via the real verbs", () => {
  it("ingest(): a 202 (job path) op moves the session counter — an identical second call is capped", async () => {
    const sources = ["https://a.com/**"]; // crawl root -> job path, resolves 202
    const maxPages = 20;
    const ceiling = ingestAuthorizedCeilingUsd(sources, 0, maxPages);
    let sigCount = 0;
    let i = 0;
    const responses: Array<() => Response> = [
      () =>
        new Response("{}", {
          status: 402,
          headers: {
            "PAYMENT-REQUIRED": challenge(String(usdToAtomic(ceiling)), "/v1/rag/ingest"),
          },
        }),
      () =>
        new Response(
          JSON.stringify({
            data: {
              collection: "c1",
              status: "ingesting",
              pages_done: 0,
              pages_total: maxPages,
              retry_after: 15,
            },
          }),
          { status: 202 },
        ),
      () =>
        new Response("{}", {
          status: 402,
          headers: {
            "PAYMENT-REQUIRED": challenge(String(usdToAtomic(ceiling)), "/v1/rag/ingest"),
          },
        }),
    ];
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      if (init && new Headers(init.headers).get("PAYMENT-SIGNATURE")) sigCount++;
      return responses[Math.min(i++, responses.length - 1)]();
    }) as unknown as typeof fetch;
    const client = new AgentRag({
      signer,
      endpoint,
      fetchImpl,
      // Room for exactly one op's settled amount, not two.
      maxSessionSpendUsd: ceiling * 1.5,
    });

    const first = await client.ingest({ sources, maxPages });
    expect(first).toMatchObject({ status: "ingesting" });
    await expect(client.ingest({ sources, maxPages })).rejects.toBeInstanceOf(SpendCapError);
    // Only the first call ever signed — the second stopped at the session cap, proving the
    // first call's 202 genuinely recorded its spend (a stale/zero counter would let both
    // calls sign).
    expect(sigCount).toBe(1);
  });

  it("extend(): a 200 op moves the session counter — an identical second call is capped", async () => {
    const ceiling = extendAuthorizedCeilingUsd(30);
    let sigCount = 0;
    let i = 0;
    const responses: Array<() => Response> = [
      () =>
        new Response("{}", {
          status: 402,
          headers: {
            "PAYMENT-REQUIRED": challenge(String(usdToAtomic(ceiling)), "/v1/rag/extend"),
          },
        }),
      () =>
        new Response(
          JSON.stringify({
            data: { collection: "c1", expires_at: "2026-10-01T00:00:00.000Z" },
          }),
          { status: 200 },
        ),
      () =>
        new Response("{}", {
          status: 402,
          headers: {
            "PAYMENT-REQUIRED": challenge(String(usdToAtomic(ceiling)), "/v1/rag/extend"),
          },
        }),
    ];
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      if (init && new Headers(init.headers).get("PAYMENT-SIGNATURE")) sigCount++;
      return responses[Math.min(i++, responses.length - 1)]();
    }) as unknown as typeof fetch;
    const client = new AgentRag({
      signer,
      endpoint,
      fetchImpl,
      maxSessionSpendUsd: ceiling * 1.5,
    });

    const first = await client.extend("c1", 30);
    expect(first.collection).toBe("c1");
    await expect(client.extend("c1", 30)).rejects.toBeInstanceOf(SpendCapError);
    expect(sigCount).toBe(1);
  });
});

// performOp's 402-handling edge cases not exercised above: a bare probe that fails for a
// reason OTHER than 402 (proving `res.status === 402` genuinely gates signing, not merely
// happens to be true in every other fixture), a malformed challenge response, the inline
// non-finite-ceiling guard's REAL call site (distinct from Probe's direct
// `assertOpPriceCeiling` unit test), and the DEFAULT_MAX_OP_USD backstop's own call site
// (reached only when a caller op declares NO authorizedCeilingUsd — `syntheticAskNoCeiling`;
// none of ask()/ingest()/extend() ever omit it today, so this is otherwise dead code from
// the public API's perspective, but it is a real, documented fallback, not speculative).
describe("performOp: 402 edge cases", () => {
  it("a bare probe that fails outright (non-402) throws without ever attempting to sign", async () => {
    // The wallet-mode bare (unsigned) discovery probe can fail for reasons unrelated to
    // payment — e.g. an upstream 5xx — before the 402/price-and-sign branch is ever
    // reached at all.
    let produced = 0;
    const spy = {
      ...signer,
      signTypedData: ((typedData: Parameters<typeof signer.signTypedData>[0]) => {
        produced++;
        return signer.signTypedData(typedData);
      }) as typeof signer.signTypedData,
    } as typeof signer;
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: "upstream", code: "internal_error" }), {
        status: 500,
      })) as unknown as typeof fetch;
    // maxRetries: 0 so the 500 surfaces instead of being retried away by the transport layer.
    const client = new TestClient({
      signer: spy,
      endpoint,
      fetchImpl,
      maxRetries: 0,
    });

    const err = await client.syntheticAsk("k1").catch((e) => e);
    expect(err).toMatchObject({ code: "internal_error", status: 500 });
    expect(produced).toBe(0);
  });

  it("a 402 with no PAYMENT-REQUIRED header throws request_failed, NO signature attempted", async () => {
    let produced = 0;
    const spy = {
      ...signer,
      signTypedData: ((typedData: Parameters<typeof signer.signTypedData>[0]) => {
        produced++;
        return signer.signTypedData(typedData);
      }) as typeof signer.signTypedData,
    } as typeof signer;
    const fetchImpl = (async () => new Response("{}", { status: 402 })) as unknown as typeof fetch;
    const client = new TestClient({ signer: spy, endpoint, fetchImpl });

    const err = await client.syntheticAsk("k1").catch((e) => e);
    expect(err).toMatchObject({ code: "request_failed", status: 402 });
    expect(err.message).toMatch(/no PAYMENT-REQUIRED challenge/);
    expect(produced).toBe(0);
  });

  it("a non-finite authorizedCeilingUsd refuses to sign at the real performOp call site (defense in depth)", async () => {
    // Unreachable via the public API today (pricing.ts only ever returns finite numbers to
    // ask()/ingest()/extend()) — but this is the last gate before a signature, so it is
    // driven directly, same rationale as the Probe comparison-polarity guards above.
    let produced = 0;
    const spy = {
      ...signer,
      signTypedData: ((typedData: Parameters<typeof signer.signTypedData>[0]) => {
        produced++;
        return signer.signTypedData(typedData);
      }) as typeof signer.signTypedData,
    } as typeof signer;
    const fetchImpl = (async () =>
      new Response("{}", {
        status: 402,
        headers: { "PAYMENT-REQUIRED": challenge("8000") },
      })) as unknown as typeof fetch;
    const client = new TestClient({ signer: spy, endpoint, fetchImpl });

    const err = await client.syntheticAsk("k1", Number.NaN).catch((e) => e);
    expect(err).toBeInstanceOf(SpendCapError);
    expect(err.message).toMatch(/not a finite amount/);
    expect(produced).toBe(0);
  });

  it("an op declaring no authorizedCeilingUsd: an honest quote at the default op ceiling still signs", async () => {
    const { client, signed, produced } = walletWith({}, [
      () =>
        new Response("{}", {
          status: 402,
          headers: {
            "PAYMENT-REQUIRED": challenge(String(usdToAtomic(DEFAULT_MAX_OP_USD))),
          },
        }),
      () =>
        new Response(JSON.stringify({ collection: "c1", matched: true, chunks: [] }), {
          status: 200,
        }),
    ]);
    const r = await client.syntheticAskNoCeiling("k1");
    expect(r.collection).toBe("c1");
    expect(signed()).toBe(true);
    expect(produced()).toBe(1);
  });

  it("an op declaring no authorizedCeilingUsd: a quote over the default op ceiling is refused, no signature", async () => {
    const over = DEFAULT_MAX_OP_USD + 0.01;
    const { client, signed, produced } = walletWith({}, [
      () =>
        new Response("{}", {
          status: 402,
          headers: { "PAYMENT-REQUIRED": challenge(String(usdToAtomic(over))) },
        }),
    ]);
    const err = await client.syntheticAskNoCeiling("k1").catch((e) => e);
    expect(err).toBeInstanceOf(SpendCapError);
    expect(err.message).toMatch(new RegExp(`built-in \\$${DEFAULT_MAX_OP_USD} op ceiling`));
    expect(signed()).toBe(false);
    expect(produced()).toBe(0);
  });
});
