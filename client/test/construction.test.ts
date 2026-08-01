import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { AgentRag } from "../src/index";

const endpoint = "https://rag.example";
const pk = generatePrivateKey();
const signer = privateKeyToAccount(pk);
const AK = `ak_${"a".repeat(64)}`;

describe("AgentRag construction", () => {
  it("wallet mode: { signer } resolves, defaults applied", () => {
    const c = new AgentRag({ signer, endpoint });
    expect(c.endpoint).toBe(endpoint);
    expect(c.network).toBe("eip155:8453");
    expect(c.maxRetries).toBe(2);
    expect(c.signer).toBe(signer);
    expect(c.accountKey).toBeUndefined();
  });

  it("wallet mode: { privateKey } resolves, converted to a signer", () => {
    const c = new AgentRag({ privateKey: pk, endpoint });
    expect(c.signer?.address).toBe(signer.address);
    expect(c.accountKey).toBeUndefined();
  });

  it("account mode: { accountKey } resolves", () => {
    const c = new AgentRag({ accountKey: AK, endpoint });
    expect(c.accountKey).toBe(AK);
    expect(c.signer).toBeUndefined();
  });

  it("trims trailing slashes from endpoint", () => {
    expect(new AgentRag({ signer, endpoint: `${endpoint}///` }).endpoint).toBe(endpoint);
  });

  it("requires exactly one auth shape", () => {
    // Unlike AgentScout's discriminated union, AgentRagOptions is FLAT — every auth field
    // is independently optional at the type level, so "exactly one" is a runtime-only
    // contract and `{ endpoint }` alone type-checks fine (no @ts-expect-error here).
    expect(() => new AgentRag({ endpoint })).toThrow(
      /provide one of \{ privateKey \} \| \{ signer \} \| \{ accountKey \}/,
    );
    expect(() => new AgentRag({ signer, accountKey: AK, endpoint })).toThrow(/exactly one/i);
    expect(() => new AgentRag({ privateKey: pk, accountKey: AK, endpoint })).toThrow(
      /exactly one/i,
    );
    expect(() => new AgentRag({ privateKey: pk, signer, endpoint })).toThrow(/at most one/i);
  });

  it("rejects a malformed accountKey", () => {
    expect(() => new AgentRag({ accountKey: "nope", endpoint })).toThrow(/ak_/);
  });

  it("rejects a malformed privateKey", () => {
    // "0xnothex" still structurally matches the `0x${string}` compile-time type (it starts
    // with "0x"), so this is a genuine RUNTIME rejection, not a type error.
    expect(() => new AgentRag({ privateKey: "0xnothex", endpoint })).toThrow(/privateKey/);
  });

  it("validates expectedPayTo as a checksummable address", () => {
    // expectedPayTo's `0x${string}` type is compile-time only — a JS/JSON caller can hand
    // the constructor anything, so the cast below simulates that and exercises the
    // runtime viem getAddress() validation the type alone cannot provide.
    expect(
      () =>
        new AgentRag({
          signer,
          endpoint,
          expectedPayTo: "not-an-address" as `0x${string}`,
        }),
    ).toThrow(/expectedPayTo/);
    const good = new AgentRag({
      signer,
      endpoint,
      expectedPayTo: signer.address,
    });
    expect(good.expectedPayTo).toBe(signer.address);
  });

  it("clamps maxRetries to a non-negative integer, default 2", () => {
    expect(new AgentRag({ signer, endpoint, maxRetries: 0 }).maxRetries).toBe(0);
    expect(new AgentRag({ signer, endpoint, maxRetries: 5 }).maxRetries).toBe(5);
  });

  it("rejects an endpoint that is not an absolute http(s) URL", () => {
    // The endpoint decides WHO issues the 402 a wallet then signs against, so a malformed
    // or non-http(s) value must fail at construction (invalid_config) — not as a bare
    // TypeError on `.replace`, and not as a cryptic "Invalid URL" from the first — possibly
    // paying — request.
    expect(() => new AgentRag({ signer, endpoint: "" })).toThrow(/endpoint/);
    expect(() => new AgentRag({ signer, endpoint: "rag.example" })).toThrow(/endpoint/);
    expect(() => new AgentRag({ signer, endpoint: "ftp://rag.example" })).toThrow(/endpoint/);
    // A config.json value survives JSON.parse as any type, so a non-string must be caught too.
    // @ts-expect-error numeric endpoint
    expect(() => new AgentRag({ signer, endpoint: 8080 })).toThrow(/endpoint/);
  });
});
