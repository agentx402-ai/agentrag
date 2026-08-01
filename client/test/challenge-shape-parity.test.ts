// client/test/challenge-shape-parity.test.ts
//
// Mirror of the SERVICE's 402 PAYMENT-REQUIRED challenge-shape pin. The service side keeps
// a matching test asserting exactly what its x402 verifier emits — that is the single
// source of truth for the envelope; this file is the client half. Here we pin the fields
// the CLIENT actually reads off the envelope + each `accepts` entry, and PROVE it by
// driving a service-shaped fixture through the real client consumers (`challengePriceUsd`
// + `buildPaymentHeader`). If the service ever drops or renames a field the client signs
// over, one of the two mirrored tests breaks — the cross-repo gate a single typecheck
// cannot provide, since client and service live in separate repos.
//
// CROSS-REPO CONTRACT: keep REQUIRED_ACCEPT_KEYS identical to the worker mirror. A change
// to the challenge envelope or to an accepts entry must land in BOTH repos in lockstep.
import { getAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { buildPaymentHeader, challengePriceUsd } from "../src/payment";

// Base mainnet — the SDK's DEFAULT_NETWORK — and its canonical USDC. `assertNetworkParity`
// checks the client-configured network AND that the challenge's asset is that network's
// canonical token, so both must be the real values, not placeholders.
const NETWORK = "eip155:8453";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAYTO = "0x000000000000000000000000000000000000dEaD";

// The accepts-entry fields the client reads. MUST match the worker mirror's list.
// `extra.{name,version}` is emitted by the worker; the client independently sources the
// EIP-712 domain name/version from the asset registry, so it is present-in-shape here for
// lockstep even though buildPaymentHeader does not read it.
const REQUIRED_ACCEPT_KEYS = [
  "scheme",
  "network",
  "asset",
  "amount",
  "payTo",
  "maxTimeoutSeconds",
  "extra",
] as const;

/** A single worker-shaped v2 accepts entry, priced for `POST /v1/rag/ask`. */
function accept(amount: string) {
  return {
    scheme: "exact",
    network: NETWORK,
    asset: USDC_BASE,
    amount,
    payTo: PAYTO,
    maxTimeoutSeconds: 600,
    extra: { name: "USD Coin", version: "2" },
  };
}

/** Worker-shaped PAYMENT-REQUIRED envelope, base64-encoded as it arrives on the header. */
function challengeHeader(amounts: string[]): string {
  return btoa(
    JSON.stringify({
      x402Version: 2,
      resource: "/v1/rag/ask",
      accepts: amounts.map(accept),
    }),
  );
}

describe("402 PAYMENT-REQUIRED challenge shape parity (client mirror)", () => {
  it("the fixture carries every field the client contract pins", () => {
    const a = accept("8000");
    for (const k of REQUIRED_ACCEPT_KEYS) {
      expect(a, `accept must carry '${k}'`).toHaveProperty(k);
    }
  });

  it("challengePriceUsd reads amount + validates network/asset off the challenge", () => {
    const header = challengeHeader(["8000"]);
    expect(challengePriceUsd(header, undefined, NETWORK)).toBeCloseTo(0.008, 9);
    // A network the client isn't configured for is rejected BEFORE the challenge is priced,
    // so a spoofed cross-chain challenge can never reach the signing step.
    expect(() => challengePriceUsd(header, undefined, "eip155:84532")).toThrow(/network/);
  });

  it("a challenge whose asset is not the network's canonical USDC is rejected", () => {
    // The other half of the pin: matching the network is not enough, because the accepts
    // entry also names the TOKEN the EIP-3009 authorization is denominated in. Without this
    // check a server on the right chain could quote "8000" of an attacker-deployed
    // 18-decimal token worth vastly more than 8000 atomic USDC. Pinned here because the SDK
    // relies on it — `buildPaymentHeader` signs whatever asset survives this gate.
    const spoofed = btoa(
      JSON.stringify({
        x402Version: 2,
        resource: "/v1/rag/ask",
        accepts: [
          {
            ...accept("8000"),
            asset: "0x00000000000000000000000000000000DeaDBeef",
          },
        ],
      }),
    );
    expect(() => challengePriceUsd(spoofed, undefined, NETWORK)).toThrow(/canonical USDC/);
  });

  it("buildPaymentHeader signs an authorization matching the challenge's amount + payTo", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const header = challengeHeader(["8000"]);
    const paySig = await buildPaymentHeader(account, header, {
      expectedNetwork: NETWORK,
    });
    const decoded = JSON.parse(atob(paySig));
    // The chosen accepts entry is copied verbatim into PaymentPayload.accepted...
    expect(decoded.accepted.scheme).toBe("exact");
    expect(decoded.accepted.network).toBe(NETWORK);
    // ...and the signed EIP-3009 authorization reflects amount -> value, payTo -> to. The
    // VALUE assertion is the load-bearing one: it pins that the SDK signs the challenge's
    // exact quoted amount rather than any self-computed sum.
    expect(decoded.payload.authorization.value).toBe("8000");
    expect(getAddress(decoded.payload.authorization.to)).toBe(getAddress(PAYTO));
    expect(getAddress(decoded.payload.authorization.from)).toBe(getAddress(account.address));
  });
});
