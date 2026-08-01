import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRagError } from "@agentrag/client";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runWallet } from "../src/commands/wallet";
import { EXIT } from "../src/output";

const KEY = `0x${"1".repeat(64)}` as const;
const ADDRESS = privateKeyToAccount(KEY).address;
const AK = `ak_${"a".repeat(64)}`;

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agentrag-wallet-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** Run `wallet <args>` against the temp AGENTRAG_HOME and collect both streams. */
function show(args: string[] = ["show"], env: NodeJS.ProcessEnv = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = runWallet(args, {
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    env: { AGENTRAG_HOME: home, ...env },
  });
  return { code, out: out.join(""), err: err.join("") };
}

function writeKeystore(name: string, body: unknown): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, name), typeof body === "string" ? body : JSON.stringify(body));
}

describe("wallet show", () => {
  it("reports the keystore wallet's address AND the file path to back up", () => {
    writeKeystore("wallet.json", { address: ADDRESS, privateKey: KEY });
    const r = show();
    expect(r.code).toBe(EXIT.OK);
    const j = JSON.parse(r.out);
    expect(j.address).toBe(ADDRESS);
    expect(j.source).toBe("keystore");
    expect(j.path).toBe(join(home, "wallet.json"));
  });

  // The whole point of the command: an auto-minted wallet holds REAL USDC, so the address (to
  // fund) and the path (to back up) must be discoverable. Neither may drag the private key along.
  it("never prints the private key", () => {
    writeKeystore("wallet.json", { address: ADDRESS, privateKey: KEY });
    const r = show();
    expect(r.out + r.err).not.toContain(KEY);
    expect(r.out).not.toMatch(/privateKey/i);
  });

  it("reports no wallet WITHOUT minting one", () => {
    const r = show();
    expect(r.code).toBe(EXIT.OK);
    const j = JSON.parse(r.out);
    expect(j.address).toBeNull();
    expect(j.source).toBe("none");
    // `wallet show` answering "is there a wallet?" must not create the answer.
    expect(existsSync(join(home, "wallet.json"))).toBe(false);
  });

  it("prefers an AGENTRAG_PRIVATE_KEY wallet over the keystore one (clientFromConfig's precedence)", () => {
    const other = `0x${"2".repeat(64)}` as const;
    writeKeystore("wallet.json", {
      address: privateKeyToAccount(other).address,
      privateKey: other,
    });
    const r = show(["show"], { AGENTRAG_PRIVATE_KEY: KEY });
    expect(r.code).toBe(EXIT.OK);
    const j = JSON.parse(r.out);
    expect(j.address).toBe(ADDRESS);
    expect(j.source).toBe("env");
    expect(r.out).not.toContain(KEY);
  });

  it("a SET-but-malformed AGENTRAG_PRIVATE_KEY is an error, not a fallback to the keystore", () => {
    // Reporting the keystore wallet here would name an identity the client never uses — every
    // real op throws on the malformed env key — and invite funding the wrong address. The error
    // escapes to runCli's mapError, which renders it as {code: "invalid_config"} (see cli.test.ts).
    writeKeystore("wallet.json", { address: ADDRESS, privateKey: KEY });
    let thrown: unknown;
    try {
      show(["show"], { AGENTRAG_PRIVATE_KEY: "0xnope" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(AgentRagError);
    expect((thrown as AgentRagError).code).toBe("invalid_config");
  });

  it("account-key mode reports no wallet, even with a stale keystore wallet present", () => {
    // An ak_ caller pays from prepaid credits; pointing at a keystore address would send funds
    // somewhere the client never spends from.
    writeKeystore("wallet.json", { address: ADDRESS, privateKey: KEY });
    const r = show(["show"], { AGENTRAG_ACCOUNT_KEY: AK });
    expect(r.code).toBe(EXIT.OK);
    const j = JSON.parse(r.out);
    expect(j.address).toBeNull();
    expect(j.source).toBe("account-key");
    expect(r.out).not.toContain(AK);
  });

  it("a stored account.json (no private key set) is account-key mode too", () => {
    writeKeystore("account.json", { accountKey: AK });
    const r = show();
    expect(JSON.parse(r.out).source).toBe("account-key");
  });

  it("surfaces a corrupt account.json instead of silently reporting a different identity", () => {
    // peekStoredAccount distinguishes ABSENT from CORRUPT and throws on the latter; runWallet
    // must not swallow it, or a malformed account.json would be silently reported as wallet mode.
    writeKeystore("account.json", "{ not json");
    expect(() => show()).toThrow(/account\.json is not valid JSON/);
  });

  it("surfaces a corrupt wallet.json rather than answering `no wallet yet`", () => {
    // The file may hold a FUNDED key. Reporting source "none" here would say the funds do not
    // exist; the keystore's error names the path so it can be inspected instead.
    writeKeystore("wallet.json", "{ not json");
    expect(() => show()).toThrow(/wallet\.json is not valid JSON/);
    // And the same for a present-but-unusable key.
    writeKeystore("wallet.json", { address: ADDRESS, privateKey: "nope" });
    expect(() => show()).toThrow(/missing or malformed privateKey/);
  });
});

describe("wallet usage", () => {
  it("requires the `show` subcommand", () => {
    for (const args of [[], ["new"], ["bogus"]]) {
      const r = show(args);
      expect(r.code).toBe(EXIT.USAGE);
      expect(JSON.parse(r.err).code).toBe("usage");
    }
  });

  it("rejects an unknown flag rather than ignoring it", () => {
    expect(() => show(["show", "--frobnicate", "1"])).toThrow(/unknown flag/);
  });
});
