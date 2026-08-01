import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { AgentRag } from "../src/index";
import { askAuthorizedCeilingUsd } from "../src/pricing";

const endpoint = "https://rag.example";
const signer = privateKeyToAccount(generatePrivateKey());
const EXPECTED = "0x0000000000000000000000000000000000000001";
const ATTACKER = "0x0000000000000000000000000000000000000002";

function challenge(payTo: string): string {
  return btoa(
    JSON.stringify({
      x402Version: 2,
      accepts: [
        {
          scheme: "exact",
          network: "eip155:8453",
          amount: "8000",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          payTo,
          resource: "/v1/rag/ask",
          description: "ask",
          mimeType: "application/json",
          maxTimeoutSeconds: 300,
        },
      ],
    }),
  );
}

// No ask() exists yet, so drive performOp directly with an ask-shaped spec.
class TestClient extends AgentRag {
  syntheticAsk(idempotencyKey: string): Promise<{ collection: string }> {
    return this.performOp<{ collection: string }>({
      method: "POST",
      path: "/v1/rag/ask",
      url: `${this.endpoint}/v1/rag/ask`,
      idempotencyKey,
      label: "ask failed",
      authorizedCeilingUsd: askAuthorizedCeilingUsd(undefined, 20),
      buildRequest: (headers) => ({
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ query: "hi" }),
      }),
      parseSuccess: async (res) => JSON.parse(await res.text()),
    });
  }
}

function walletWith(payTo: string, expectedPayTo: string) {
  let signed = false;
  const fetchImpl = (async (_u: any, init?: RequestInit) => {
    if (init && new Headers(init.headers).get("PAYMENT-SIGNATURE")) signed = true;
    return new Response("{}", {
      status: 402,
      headers: { "PAYMENT-REQUIRED": challenge(payTo) },
    });
  }) as unknown as typeof fetch;
  return {
    client: new TestClient({
      signer,
      endpoint,
      fetchImpl,
      expectedPayTo: expectedPayTo as `0x${string}`,
    }),
    signed: () => signed,
  };
}

describe("expectedPayTo recipient pin", () => {
  it("rejects a challenge whose payTo differs, NO signature produced", async () => {
    const { client, signed } = walletWith(ATTACKER, EXPECTED);
    await expect(client.syntheticAsk("k1")).rejects.toMatchObject({
      code: "payto_mismatch",
    });
    expect(signed()).toBe(false);
  });
});
