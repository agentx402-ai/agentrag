/**
 * Lifecycle test for `agentrag mcp`: verifies the server stays alive long enough to serve
 * requests and does NOT exit immediately after connect (the "connect then die" regression).
 *
 * Spawns the built binary (`dist/cli.js mcp`) via StdioClientTransport with a dummy private key
 * so wallet mode resolves locally, and points AGENTRAG_ENDPOINT at a tiny in-test HTTP stub so a
 * real `rag_status` call round-trips end to end (transport -> SDK -> network -> tool handler)
 * without touching the live service.
 *
 * Requires the CLI (and client) to be built first (`npm run build`); CI runs build before test.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VERSION } from "../src/version";

// dist/cli.js relative to the workspace root (cli/)
const CLI_PATH = join(import.meta.dirname, "..", "dist", "cli.js");
const DUMMY_KEY = `0x${"1".repeat(64)}`;

// A canned collection-status body; GET /v1/rag/collection/:id is free (identity-signed) and
// never signs or spends — the stub ignores auth headers entirely, same as Scout's /quote stub.
const STATUS_BODY = {
  data: {
    collection: "docs",
    model: "@cf/baai/bge-m3",
    pages: 1,
    chunks: 3,
    created_at: "2026-01-01T00:00:00.000Z",
    expires_at: "2027-01-01T00:00:00.000Z",
  },
};

let httpServer: Server;
let endpoint: string;

beforeAll(async () => {
  httpServer = createServer((req, res) => {
    if (req.method === "GET" && req.url?.startsWith("/v1/rag/collection/")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(STATUS_BODY));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found", code: "not_found" }));
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

/** True iff a process with this pid is still signalable (ESRCH means it's gone). Cross-platform
 * per Node's own docs: `process.kill(pid, 0)` tests existence without sending a real signal. */
function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("MCP server lifecycle", () => {
  it("stays alive, lists the 6 rag tools, reports VERSION, and serves a live rag_status", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentrag-mcp-"));
    const transport = new StdioClientTransport({
      command: process.execPath, // node
      args: [CLI_PATH, "mcp"],
      env: {
        ...process.env,
        AGENTRAG_HOME: home,
        AGENTRAG_ENDPOINT: endpoint,
        AGENTRAG_PRIVATE_KEY: DUMMY_KEY,
        AGENTRAG_NETWORK: "eip155:8453",
      },
    });
    // Review fix round 1 (Important #2): stdout purity was previously observable ONLY at
    // startup (the sole test wiring onerror never calls a tool; the sole test that calls a tool
    // never wired onerror) — a stray console.log/process.stdout.write inside a TOOL HANDLER
    // corrupted the JSON-RPC channel with the full suite green. Wiring onerror here, in the test
    // that actually round-trips rag_status, closes that gap.
    const errors: unknown[] = [];
    transport.onerror = (e) => errors.push(e);
    const client = new Client({ name: "test-client", version: "0.0.1" });
    client.onerror = (e) => errors.push(e);
    try {
      await client.connect(transport);

      // 1. List tools — exactly the six rag tools, with truthful names.
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        "rag_ask",
        "rag_delete",
        "rag_extend",
        "rag_ingest",
        "rag_status",
        "rag_wallet_address",
      ]);

      // 1b. The annotations a HOST actually sees over the wire (not just the in-process
      // registry): a paid verb must never advertise itself as read-only. destructiveHint
      // defaults to TRUE when omitted, so the additive verbs (rag_ask, rag_extend) set it
      // explicitly false; rag_ingest (overwrites via refresh) and rag_delete are destructive.
      for (const name of ["rag_ask", "rag_ingest", "rag_extend"]) {
        expect(tools.find((t) => t.name === name)?.annotations?.readOnlyHint).toBe(false);
      }
      expect(tools.find((t) => t.name === "rag_ask")?.annotations?.destructiveHint).toBe(false);
      expect(tools.find((t) => t.name === "rag_extend")?.annotations?.destructiveHint).toBe(false);
      expect(tools.find((t) => t.name === "rag_ingest")?.annotations?.destructiveHint).toBe(true);
      expect(tools.find((t) => t.name === "rag_delete")?.annotations?.destructiveHint).toBe(true);

      // 2. The initialize handshake advertises the CLI VERSION.
      expect(client.getServerVersion()?.version).toBe(VERSION);

      // 3. A live rag_status round-trips through the stub (free, identity-signed, no spend).
      const res = await client.callTool({
        name: "rag_status",
        arguments: { collection: "docs" },
      });
      const content = res.content as Array<{ type: string; text: string }>;
      expect(content).toHaveLength(1);
      const parsed = JSON.parse(content[0].text);
      expect(parsed.collection).toBe("docs");
      expect(parsed.chunks).toBe(3);

      // Review fix round 1 (Important #2, cont'd): assert AFTER the tool call, not just after
      // startup — this is the assertion a handler-level stdout write needs to fail.
      expect(errors).toHaveLength(0);

      // Review fix round 1 (Important #5): the file's own header comment claims this test
      // "verifies the server stays alive ... and does NOT exit immediately after connect", but
      // nothing checked that beyond the calls above succeeding. Earn the claim: confirm the
      // child process is still signalable after an idle beat, then prove it is genuinely still
      // SERVING (not merely not-yet-reaped) with a second round-trip call.
      const pid = transport.pid;
      expect(pid).not.toBeNull();
      expect(pidIsAlive(pid as number)).toBe(true);
      await sleep(300);
      expect(pidIsAlive(pid as number)).toBe(true);
      const second = await client.callTool({
        name: "rag_status",
        arguments: { collection: "docs" },
      });
      expect(JSON.parse((second.content as Array<{ text: string }>)[0].text).collection).toBe(
        "docs",
      );
    } finally {
      await client.close();
      rmSync(home, { recursive: true, force: true });
    }
  }, 20_000 /* generous timeout for process spawn */);

  // stdout hygiene: with NO wallet key, startMcp auto-provisions a wallet and emits the
  // "created a new wallet" notice — which MUST go to stderr, because stdout is the JSON-RPC
  // channel. A stray write to stdout corrupts the framing; the SDK transport surfaces that via
  // onerror. Assert no transport/client errors while tools still list (proving stderr, not stdout).
  it("auto-provision notice goes to stderr, not the JSON-RPC stdout channel", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentrag-prov-"));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI_PATH, "mcp"],
      env: {
        ...process.env,
        AGENTRAG_HOME: home, // isolate keystore -> forces a fresh auto-provision
        AGENTRAG_ENDPOINT: endpoint,
        AGENTRAG_PRIVATE_KEY: "", // empty -> unset: no wallet configured -> auto-provision fires
        AGENTRAG_ACCOUNT_KEY: "", // empty -> not account mode
      },
    });
    const errors: unknown[] = [];
    transport.onerror = (e) => errors.push(e);
    const client = new Client({ name: "test-client", version: "0.0.1" });
    client.onerror = (e) => errors.push(e);
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(6); // handshake + listing succeeded ...
      expect(errors).toHaveLength(0); // ... with NO framing corruption from a stray stdout notice
    } finally {
      await client.close();
      rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);

  // The auto-minted wallet must hold real USDC, so an agent has to be able to find the address
  // to fund and the file to back up — without ever seeing the key. Same spawn checks the
  // startup stderr notice, which fires on this exact config (no session cap set).
  it("rag_wallet_address discovers the auto-minted wallet, and startup warns about the missing session cap", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentrag-walletaddr-"));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI_PATH, "mcp"],
      env: {
        ...process.env,
        AGENTRAG_HOME: home, // isolate keystore -> forces a fresh auto-provision
        AGENTRAG_ENDPOINT: endpoint,
        AGENTRAG_PRIVATE_KEY: "",
        AGENTRAG_ACCOUNT_KEY: "",
        AGENTRAG_MAX_SESSION_SPEND_USD: "", // unset -> the startup warning must fire
      },
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString();
    });
    const client = new Client({ name: "test-client", version: "0.0.1" });
    try {
      await client.connect(transport);
      const res = await client.callTool({
        name: "rag_wallet_address",
        arguments: {},
      });
      const content = res.content as Array<{ type: string; text: string }>;
      const reported = JSON.parse(content[0].text);

      // The address it reports is the one actually minted into the keystore ...
      const walletFile = join(home, "wallet.json");
      const minted = JSON.parse(readFileSync(walletFile, "utf8")) as {
        address: string;
        privateKey: string;
      };
      expect(reported.address).toBe(minted.address);
      expect(reported.path).toBe(walletFile);
      expect(reported.source).toBe("keystore");
      // ... and the key that address holds NEVER crosses the wire.
      expect(content[0].text).not.toContain(minted.privateKey);
      expect(content[0].text).not.toMatch(/privateKey/i);

      expect(stderr).toContain("no session spend cap configured");
      expect(stderr).not.toContain(minted.privateKey);
    } finally {
      await client.close();
      rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);

  it("no startup warning when a session spend cap IS configured", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentrag-cap-"));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI_PATH, "mcp"],
      env: {
        ...process.env,
        AGENTRAG_HOME: home,
        AGENTRAG_ENDPOINT: endpoint,
        AGENTRAG_PRIVATE_KEY: DUMMY_KEY,
        AGENTRAG_MAX_SESSION_SPEND_USD: "1.00",
      },
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString();
    });
    const client = new Client({ name: "test-client", version: "0.0.1" });
    try {
      await client.connect(transport);
      await client.listTools(); // round-trip so startup output has certainly been flushed
      expect(stderr).not.toContain("no session spend cap configured");
    } finally {
      await client.close();
      rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);

  // Distinct from the auto-provisioned-wallet test above: THAT one's identity comes from the
  // on-disk keystore, which scrubSensitiveEnv never touches, so it can't catch a startMcp that
  // scrubs AGENTRAG_PRIVATE_KEY too early. This one configures the wallet via the ENV KEY
  // itself, so it fails if resolveWalletIdentity ever moved to run AFTER scrubSensitiveEnv (it
  // would then read an already-deleted env var and silently report the keystore/none identity
  // instead of the one the client actually pays from).
  it("rag_wallet_address reports the ENV-configured wallet (resolved before the env is scrubbed)", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentrag-walletenv-"));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI_PATH, "mcp"],
      env: {
        ...process.env,
        AGENTRAG_HOME: home,
        AGENTRAG_ENDPOINT: endpoint,
        AGENTRAG_PRIVATE_KEY: DUMMY_KEY,
      },
    });
    const client = new Client({ name: "test-client", version: "0.0.1" });
    try {
      await client.connect(transport);
      const res = await client.callTool({
        name: "rag_wallet_address",
        arguments: {},
      });
      const content = res.content as Array<{ type: string; text: string }>;
      const reported = JSON.parse(content[0].text);
      expect(reported.source).toBe("env");
      expect(reported.address).toBe(privateKeyToAccount(DUMMY_KEY as `0x${string}`).address);
      expect(content[0].text).not.toContain(DUMMY_KEY);
    } finally {
      await client.close();
      rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);
});
