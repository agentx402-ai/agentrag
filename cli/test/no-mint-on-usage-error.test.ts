import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli";
import { walletPath } from "../src/keystore";
import { EXIT } from "../src/output";

const sink = () => {};

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "agentrag-no-mint-"));
}

// Regression: a valid COMMAND with a missing or invalid required argument used to mint and
// persist a wallet to disk (clientFromConfig, built during config resolution in cli.ts) BEFORE
// the usage error was ever reported. The observation that matters is whether wallet.json landed
// on disk, not merely the error text — a reintroduced bug here could still print the right
// error while silently minting again.
describe("a usage error never mints a wallet", () => {
  const usageErrorShapes: Array<{ name: string; argv: string[] }> = [
    { name: "ask with no query", argv: ["ask"] },
    { name: "status with no collection", argv: ["status"] },
    { name: "delete with no collection", argv: ["delete"] },
    { name: "extend with no collection", argv: ["extend"] },
    { name: "extend with no --days", argv: ["extend", "mycol"] },
    {
      name: "extend with an out-of-range --days",
      argv: ["extend", "mycol", "--days", "999"],
    },
    {
      name: "ingest --documents pointing at a missing file",
      argv: ["ingest", "--documents", "/no/such/file.json"],
    },
    // Same root cause, a different validation gate: a flag valid on another command is also a
    // usage error (see e.g. commands-ask.test.ts's "rejects a flag valid on another command"),
    // and it too was previously checked only after the client (and therefore the wallet) was
    // built — the per-command flag allowlist lives in a SECOND, restricted parseFlags call that
    // ran inside runXxx, downstream of clientFromConfig.
    {
      name: "ask with a flag valid on another command (--refresh)",
      argv: ["ask", "q", "--refresh"],
    },
    {
      name: "ingest with a flag valid on another command (--wait)",
      argv: ["ingest", "--sources", "https://ex.example/**", "--wait"],
    },
    {
      name: "status with a flag valid on another command (--top-k)",
      argv: ["status", "my-docs", "--top-k", "5"],
    },
    {
      name: "delete with a flag valid on another command (--days)",
      argv: ["delete", "my-docs", "--days", "30"],
    },
    {
      name: "extend with a flag valid on another command (--sources)",
      argv: ["extend", "my-docs", "--days", "30", "--sources", "https://ex.example"],
    },
  ];

  it.each(usageErrorShapes)("$name -> usage error, no wallet.json written", async ({ argv }) => {
    const home = tmpHome();
    try {
      const err: string[] = [];
      const code = await runCli(argv, {
        env: { AGENTRAG_HOME: home },
        stdout: sink,
        stderr: (s) => err.push(s),
      });
      expect(code).toBe(EXIT.USAGE);
      expect(JSON.parse(err.join("")).code).toBe("usage");
      expect(existsSync(walletPath({ AGENTRAG_HOME: home }))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // Already correct before this fix (unknown command is rejected before any parseFlags/config
  // work runs at all) — pinned here too so a future change can't regress it silently.
  it("unknown command -> usage error, no wallet.json written (already correct)", async () => {
    const home = tmpHome();
    try {
      const err: string[] = [];
      const code = await runCli(["--definitely-not-a-real-flag"], {
        env: { AGENTRAG_HOME: home },
        stdout: sink,
        stderr: (s) => err.push(s),
      });
      expect(code).toBe(EXIT.USAGE);
      expect(existsSync(walletPath({ AGENTRAG_HOME: home }))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // Also already correct: a flag missing its value is caught by cli.ts's OWN unrestricted
  // parseFlags call (used to extract global config flags), which runs before client
  // construction regardless of this fix.
  it("ask with a flag missing its value (--collection) -> usage error, no wallet.json written (already correct)", async () => {
    const home = tmpHome();
    try {
      const err: string[] = [];
      const code = await runCli(["ask", "q", "--collection"], {
        env: { AGENTRAG_HOME: home },
        stdout: sink,
        stderr: (s) => err.push(s),
      });
      expect(code).toBe(EXIT.USAGE);
      expect(existsSync(walletPath({ AGENTRAG_HOME: home }))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // The mint-on-first-use onboarding feature is deliberate and must survive this fix: a
  // genuinely valid invocation should still mint. AGENTRAG_ENDPOINT targets a local address
  // nothing listens on so the actual network call fails fast and stays fully offline; the mint
  // happens (and is observed here) before that call is ever attempted.
  it("a genuinely valid invocation still mints a wallet on first use", async () => {
    const home = tmpHome();
    try {
      const code = await runCli(["status", "my-collection"], {
        env: { AGENTRAG_HOME: home, AGENTRAG_ENDPOINT: "http://127.0.0.1:1" },
        stdout: sink,
        stderr: sink,
      });
      expect(code).not.toBe(EXIT.USAGE);
      expect(existsSync(walletPath({ AGENTRAG_HOME: home }))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
