import { describe, expect, it } from "vitest";
import { AgentRag, ASK_BASE_USD } from "../src/index";

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
