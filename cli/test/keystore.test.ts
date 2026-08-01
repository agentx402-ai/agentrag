import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { clientFromConfig } from "../src/config";
import {
  accountPath,
  getOrCreateStoredWallet,
  peekStoredAccount,
  peekStoredWallet,
  walletPath,
} from "../src/keystore";

function tmpEnv(): NodeJS.ProcessEnv {
  return { AGENTRAG_HOME: mkdtempSync(join(tmpdir(), "agentrag-ks-")) };
}
const clean = (env: NodeJS.ProcessEnv) =>
  rmSync(env.AGENTRAG_HOME as string, { recursive: true, force: true });

const AK_FIXTURE = `ak_${"a".repeat(64)}`;
/** Write a valid account.json fixture (AgentRAG never mints one — it's funded out-of-band via AgentKV). */
function writeAccountFile(env: NodeJS.ProcessEnv, accountKey = AK_FIXTURE): string {
  writeFileSync(accountPath(env), `${JSON.stringify({ accountKey }, null, 2)}\n`);
  return accountKey;
}

describe("keystore — wallet", () => {
  it("mints a wallet on first call, then reuses it (idempotent)", () => {
    const env = tmpEnv();
    try {
      expect(peekStoredWallet(env)).toBeNull();
      const a = getOrCreateStoredWallet(env);
      expect(a.created).toBe(true);
      expect(a.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(a.privateKey).toMatch(/^0x[0-9a-fA-F]{64}$/);

      const b = getOrCreateStoredWallet(env);
      expect(b.created).toBe(false);
      expect(b.privateKey).toBe(a.privateKey); // same wallet, not a fresh one
      expect(peekStoredWallet(env)?.address).toBe(a.address);
    } finally {
      clean(env);
    }
  });

  it("peekStoredWallet returns only the public address + path — never the private key", () => {
    const env = tmpEnv();
    try {
      getOrCreateStoredWallet(env);
      const peeked = peekStoredWallet(env);
      expect(peeked?.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(peeked).not.toHaveProperty("privateKey"); // secret never leaves the keystore
    } finally {
      clean(env);
    }
  });

  it.skipIf(process.platform === "win32")("persists the key file as 0600", () => {
    const env = tmpEnv();
    try {
      getOrCreateStoredWallet(env);
      expect(statSync(walletPath(env)).mode & 0o777).toBe(0o600);
    } finally {
      clean(env);
    }
  });

  it("first-run EEXIST recovery: a valid racer file is adopted (created:false), never the loser's key", () => {
    const env = tmpEnv();
    try {
      const competitorKey = generatePrivateKey();
      const competitorAddr = privateKeyToAccount(competitorKey).address;
      writeFileSync(
        walletPath(env),
        `${JSON.stringify({ address: competitorAddr, privateKey: competitorKey }, null, 2)}\n`,
      );
      const w = getOrCreateStoredWallet(env);
      expect(w.created).toBe(false);
      expect(w.privateKey).toBe(competitorKey); // adopts the winner, never mints a losing key
    } finally {
      clean(env);
    }
  });

  it("clientFromConfig auto-provisions when no key is set, and notifies once", () => {
    const env = tmpEnv();
    try {
      const cfg = { endpoint: "https://x.example", network: "eip155:8453" };
      let firstNotice = "";
      clientFromConfig(cfg, { env, notify: (m) => (firstNotice = m) });
      const minted = peekStoredWallet(env);
      expect(minted?.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(firstNotice).toContain(minted?.address as string); // the notice names the new wallet

      let secondNotice = "";
      clientFromConfig(cfg, { env, notify: (m) => (secondNotice = m) });
      expect(peekStoredWallet(env)?.address).toBe(minted?.address); // same wallet reused
      expect(secondNotice).toBe(""); // not "created" again -> no notice
    } finally {
      clean(env);
    }
  });
});

// A wallet file that EXISTS but is unusable must never read as "no wallet": it may hold a
// FUNDED key. Treating it as absent hid the problem AND sent the mint path into the
// create-exclusive write, which then failed with a bare EEXIST that named neither the file nor
// the cause. Same ABSENT-vs-CORRUPT split the account file below already makes.
describe("keystore — wallet file: absent vs corrupt", () => {
  const cfgBase = {
    endpoint: "https://x.example",
    network: "eip155:8453",
  } as const;

  it("corrupt wallet.json throws from peek, mint, and client construction alike", () => {
    const env = tmpEnv();
    try {
      // Exactly what a non-atomic write + a crash leaves behind.
      writeFileSync(walletPath(env), '{"address":"0x0","privateKey":"0x1234');
      expect(() => peekStoredWallet(env)).toThrow(/wallet file .* is not valid JSON/);
      expect(() => getOrCreateStoredWallet(env)).toThrow(/wallet file .* is not valid JSON/);
      expect(() => clientFromConfig({ ...cfgBase }, { env })).toThrow(/wallet file/);
    } finally {
      clean(env);
    }
  });

  it("a wallet.json with no usable privateKey throws instead of minting a second wallet", () => {
    const env = tmpEnv();
    try {
      writeFileSync(walletPath(env), JSON.stringify({ address: "0x0", privateKey: "nope" }));
      expect(() => peekStoredWallet(env)).toThrow(/privateKey/);
      expect(() => getOrCreateStoredWallet(env)).toThrow(/privateKey/);
    } finally {
      clean(env);
    }
  });

  it("the corrupt-wallet error names the path but never the key material", () => {
    const env = tmpEnv();
    try {
      const key = generatePrivateKey(); // a real (funded-looking) key inside a truncated file
      writeFileSync(walletPath(env), `{"privateKey":"${key}"`);
      expect(() => peekStoredWallet(env)).toThrow(/not valid JSON/);
      let msg = "";
      try {
        peekStoredWallet(env);
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg).toContain(walletPath(env));
      expect(msg).not.toContain(key);
    } finally {
      clean(env);
    }
  });

  it.skipIf(process.platform === "win32")(
    "a wallet.json that exists but can't be read throws (not mistaken for absent)",
    () => {
      const env = tmpEnv();
      try {
        mkdirSync(walletPath(env)); // stand-in for EACCES: present, unreadable as a file
        expect(() => peekStoredWallet(env)).toThrow(/EISDIR/);
        expect(() => getOrCreateStoredWallet(env)).toThrow(/EISDIR/);
      } finally {
        clean(env);
      }
    },
  );
});

describe("keystore — account file", () => {
  it("peek reads back a written account file (ak_ bearer, no encryption key)", () => {
    const env = tmpEnv();
    try {
      expect(peekStoredAccount(env)).toBeNull(); // never auto-created — funded out-of-band

      const ak = writeAccountFile(env);
      const peeked = peekStoredAccount(env);
      expect(peeked?.accountKey).toBe(ak);
      expect(peeked?.accountKey).toMatch(/^ak_[0-9a-f]{64}$/);
      expect(peeked?.path).toBe(accountPath(env));
      expect(peeked?.created).toBe(false);
      expect(peeked).not.toHaveProperty("encryptionKey"); // AgentRAG has no encryption layer
    } finally {
      clean(env);
    }
  });

  // peek must distinguish ABSENT (null) from PRESENT-but-CORRUPT (throw), so a malformed file
  // can't be mistaken for "no account" and silently switch namespaces.
  it("absent account.json -> null; present-but-corrupt -> throws (never null)", () => {
    const env = tmpEnv();
    try {
      expect(peekStoredAccount(env)).toBeNull(); // genuinely absent

      writeFileSync(accountPath(env), "{ not json"); // not valid JSON
      expect(() => peekStoredAccount(env)).toThrow(/valid JSON/);

      writeFileSync(accountPath(env), JSON.stringify({ accountKey: "nope" })); // bad accountKey
      expect(() => peekStoredAccount(env)).toThrow(/accountKey/);
    } finally {
      clean(env);
    }
  });
});

describe("clientFromConfig — account-mode auto-detect", () => {
  const cfgBase = {
    endpoint: "https://x.example",
    network: "eip155:8453",
  } as const;
  const AK = `ak_${"a".repeat(64)}`;

  it("AGENTRAG_ACCOUNT_KEY -> account-mode client (bearer, no signer)", () => {
    const env = tmpEnv();
    try {
      const client = clientFromConfig({ ...cfgBase, accountKey: AK }, { env });
      expect((client as any).accountKey).toBe(AK); // raw bearer is the identity
      expect((client as any).signer).toBeUndefined(); // managed account can't sign
    } finally {
      clean(env);
    }
  });

  it("an account.json file (and no AGENTRAG_PRIVATE_KEY) -> account-mode client", () => {
    const env = tmpEnv();
    try {
      const ak = writeAccountFile(env);
      const client = clientFromConfig({ ...cfgBase }, { env });
      expect((client as any).accountKey).toBe(ak); // picked up from the file
      expect((client as any).signer).toBeUndefined();
    } finally {
      clean(env);
    }
  });

  it("AGENTRAG_PRIVATE_KEY wins over an existing account.json (wallet mode)", () => {
    const env = tmpEnv();
    try {
      writeAccountFile(env); // account file present...
      const client = clientFromConfig({ ...cfgBase, privateKey: `0x${"c".repeat(64)}` }, { env });
      expect((client as any).accountKey).toBeUndefined(); // ...but env privkey wins
      expect((client as any).signer).toBeDefined(); // wallet mode -> a signer
    } finally {
      clean(env);
    }
  });

  it("no account env/file -> existing wallet path (auto-provisioned signer)", () => {
    const env = tmpEnv();
    try {
      const client = clientFromConfig({ ...cfgBase }, { env });
      expect((client as any).accountKey).toBeUndefined();
      expect((client as any).signer).toBeDefined(); // auto-provisioned wallet has a signer
    } finally {
      clean(env);
    }
  });

  it("malformed AGENTRAG_ACCOUNT_KEY -> clear config error", () => {
    const env = tmpEnv();
    try {
      expect(() => clientFromConfig({ ...cfgBase, accountKey: "ak_not-hex" }, { env })).toThrow(
        /ak_<64 lowercase hex>/,
      );
    } finally {
      clean(env);
    }
  });

  // A present-but-CORRUPT account.json must THROW — NOT silently fall through to wallet mode (a
  // namespace switch that strands the account). Money-safety: no wallet is auto-provisioned.
  it("present-but-corrupt account.json -> throws (does NOT silently mint a wallet)", () => {
    const env = tmpEnv();
    try {
      writeFileSync(accountPath(env), "{ not json");
      expect(() => clientFromConfig({ ...cfgBase }, { env })).toThrow(/valid JSON/);
      expect(peekStoredWallet(env)).toBeNull(); // did NOT fall through to wallet mode
    } finally {
      clean(env);
    }
  });
});
