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
    let produced = 0;
    const spy = {
      ...signer,
      signTypedData: (async (args: Parameters<typeof signer.signTypedData>[0]) => {
        produced++;
        return signer.signTypedData(args);
      }) as typeof signer.signTypedData,
    } as typeof signer;
    const ceiling = extendAuthorizedCeilingUsd(30);
    const fetchImpl = (async () =>
      new Response("{}", {
        status: 402,
        headers: {
          "PAYMENT-REQUIRED": challenge(String(usdToAtomic(ceiling + 0.01))),
        },
      })) as unknown as typeof fetch;
    const client = new AgentRag({ signer: spy, endpoint, fetchImpl });

    await expect(client.extend("c1", 30)).rejects.toBeInstanceOf(SpendCapError);
    expect(produced).toBe(0); // no signature was ever produced, not merely unsent
  });

  it("an honest quote at the ceiling is signed (the guard does not false-reject its own ceiling)", async () => {
    let signed = false;
    const ceiling = extendAuthorizedCeilingUsd(90);
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
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
