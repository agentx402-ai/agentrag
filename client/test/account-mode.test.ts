import { describe, expect, it } from "vitest";
import { AgentRag, ASK_BASE_USD, SpendCapError } from "../src/index";

// Account-key mode: an opaque `ak_…` bearer is the identity and each call debits prepaid
// credits. The request path is a SINGLE bearer-authenticated call — never the wallet-mode
// probe->402->sign dance — so no PAYMENT-SIGNATURE is ever produced (there is no signer to
// produce one). No ask()/ingest()/extend() exist yet, so these tests drive `performOp`
// directly through a thin protected-access subclass, with an ask-shaped spec — exactly
// what a future `ask()` will hand it.

const endpoint = "https://rag.example";
const AK = `ak_${"a".repeat(64)}`;

class TestClient extends AgentRag {
  syntheticAsk<T>(parseSuccess: (res: Response) => Promise<T>): Promise<T> {
    return this.performOp<T>({
      method: "POST",
      path: "/v1/rag/ask",
      url: `${this.endpoint}/v1/rag/ask`,
      idempotencyKey: "test-idem-key",
      label: "ask failed",
      authorizedCeilingUsd: ASK_BASE_USD,
      buildRequest: (headers) => ({
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ query: "hi" }),
      }),
      parseSuccess,
    });
  }
}

function scripted(response: () => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: any, init?: RequestInit) => {
    calls.push({
      url: typeof input === "string" ? input : input.url,
      init: init ?? {},
    });
    return response();
  }) as unknown as typeof fetch;
  return {
    client: new TestClient({ accountKey: AK, endpoint, fetchImpl }),
    calls,
  };
}

describe("account-key mode request path", () => {
  it("a 200 op carries Authorization: Bearer ak_… and NO PAYMENT-SIGNATURE", async () => {
    const { client, calls } = scripted(
      () =>
        new Response(JSON.stringify({ collection: "c1", matched: true, chunks: [] }), {
          status: 200,
        }),
    );
    const r = await client.syntheticAsk(async (res) => JSON.parse(await res.text()));
    expect((r as { collection: string }).collection).toBe("c1");
    expect(calls.length).toBe(1); // one bearer-authenticated request, no probe/retry dance
    const h = new Headers(calls[0].init.headers);
    expect(h.get("Authorization")).toBe(`Bearer ${AK}`);
    expect(h.get("PAYMENT-SIGNATURE")).toBeNull(); // account mode never signs an x402 challenge
  });

  it("a 402 insufficient_credits throws a typed error with no signing attempt", async () => {
    const { client, calls } = scripted(
      () =>
        new Response(
          JSON.stringify({
            error: "out of credits",
            code: "insufficient_credits",
          }),
          {
            status: 402,
          },
        ),
    );
    await expect(
      client.syntheticAsk(async (res) => JSON.parse(await res.text())),
    ).rejects.toMatchObject({
      code: "insufficient_credits",
      status: 402,
    });
    // Exactly one request; it carried the bearer and never a signature (fund out-of-band).
    expect(calls.length).toBe(1);
    expect(new Headers(calls[0].init.headers).get("PAYMENT-SIGNATURE")).toBeNull();
  });
});

// AGENTS.md money-safety invariant 1: "spend caps bound EVERY paying path." Account-key mode
// pays from PREPAID CREDITS (real money), so maxSpendUsd / maxSessionSpendUsd must bind here
// exactly as they do wallet mode. A prior version returned from the bearer branch before any
// spend check, so both caps were dead in account-key mode — verified by driving the built
// client (3x ingest at $1 each all settled under $0.000001 caps). These pin the fix.
describe("account-key mode enforces spend caps (invariant 1)", () => {
  const ask200 = () =>
    new Response(
      JSON.stringify({
        data: { collection: "c1", matched: true, chunks: [] },
        usage: { price_usd: ASK_BASE_USD },
        request_id: "r-ask",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  it("a per-call maxSpendUsd below the op's authorized ceiling throws SpendCapError, NO request issued", async () => {
    let requests = 0;
    const fetchImpl = (async () => {
      requests++;
      return ask200();
    }) as unknown as typeof fetch;
    const client = new AgentRag({
      accountKey: AK,
      endpoint,
      fetchImpl,
      maxSpendUsd: ASK_BASE_USD / 2, // below the ask's own authorized ceiling
    });
    await expect(client.ask("hi", { collection: "c1" })).rejects.toBeInstanceOf(SpendCapError);
    expect(requests).toBe(0); // refused BEFORE the network, exactly like wallet mode
  });

  it("cumulative maxSessionSpendUsd bounds repeated account-key ops by ACTUAL settled usage", async () => {
    let requests = 0;
    const fetchImpl = (async () => {
      requests++;
      return ask200();
    }) as unknown as typeof fetch;
    // Budget for ~1.5 asks: the first settles ASK_BASE_USD, the second is refused before it spends.
    const client = new AgentRag({
      accountKey: AK,
      endpoint,
      fetchImpl,
      maxSessionSpendUsd: ASK_BASE_USD * 1.5,
    });
    await client.ask("hi", { collection: "c1" }); // settles ASK_BASE_USD, recorded from usage
    await expect(client.ask("hi", { collection: "c1" })).rejects.toBeInstanceOf(SpendCapError);
    expect(requests).toBe(1); // only the first op reached the network
  });
});
