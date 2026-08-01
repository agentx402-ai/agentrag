import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRagError, AgentXError, SpendCapError } from "@agentrag/client";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli";
import { EXIT } from "../src/output";
import { VERSION } from "../src/version";

const sink = () => {};
// A guaranteed-nonexistent AGENTRAG_HOME: resolveConfig/readConfigFile still run even when a
// fake `client` is injected (only clientFromConfig is skipped), so tests that inject a client
// still need a safe home dir rather than falling through to this machine's real ~/.agentrag.
const FIXTURE_HOME = "/nonexistent-agentrag-cli-test-fixture";

describe("runCli dispatch", () => {
  it("unknown command -> EXIT.USAGE and a usage error on stderr", async () => {
    const err: string[] = [];
    const code = await runCli(["frobnicate"], {
      stdout: sink,
      stderr: (s) => err.push(s),
    });
    expect(code).toBe(EXIT.USAGE);
    expect(JSON.parse(err.join("")).code).toBe("usage");
  });

  it("--version prints VERSION and exits OK", async () => {
    const out: string[] = [];
    const code = await runCli(["--version"], {
      stdout: (s) => out.push(s),
      stderr: sink,
    });
    expect(code).toBe(EXIT.OK);
    expect(out.join("")).toBe(`${VERSION}\n`);
  });

  it("no command prints help and exits OK", async () => {
    const out: string[] = [];
    const code = await runCli([], { stdout: (s) => out.push(s), stderr: sink });
    expect(code).toBe(EXIT.OK);
    expect(out.join("")).toContain("agentrag");
  });

  it("help and the unknown-command hint both list every command, including `wallet` and `mcp`", async () => {
    const out: string[] = [];
    await runCli(["--help"], { stdout: (s) => out.push(s), stderr: sink });
    const help = out.join("");
    for (const c of ["ask", "ingest", "extend", "status", "delete", "wallet show", "mcp"]) {
      expect(help).toContain(c);
    }
    const err: string[] = [];
    await runCli(["frobnicate"], { stdout: sink, stderr: (s) => err.push(s) });
    const hint = JSON.parse(err.join("")).hint as string;
    expect(hint).toContain("wallet");
    expect(hint).toContain("mcp");
  });

  it("pins the exit-code table mapError relies on (scripts branch on these numbers)", () => {
    // Independent literal pin, not derived from output.ts's own constant — see the money-path
    // testing note in CLAUDE.md: a test must not compute its expectation from the code it guards.
    expect(EXIT.OK).toBe(0);
    expect(EXIT.GENERIC).toBe(1);
    expect(EXIT.USAGE).toBe(2);
    expect(EXIT.PAYMENT).toBe(3);
    expect(EXIT.NOT_FOUND).toBe(4);
  });
});

describe("runCli `mcp` (a placeholder ahead of Task 9's real server)", () => {
  it("is a recognized command, not `unknown command`", async () => {
    const err: string[] = [];
    const code = await runCli(["mcp"], {
      stdout: sink,
      stderr: (s) => err.push(s),
    });
    expect(code).not.toBe(EXIT.USAGE);
    expect(JSON.parse(err.join("")).code).not.toBe("usage");
  });

  it("fails with a typed not_implemented error, through the SAME error handler as every other command", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(["mcp"], {
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
    });
    expect(code).toBe(EXIT.GENERIC);
    expect(JSON.parse(err.join("")).code).toBe("not_implemented");
    expect(out.join("")).toBe(""); // no stdout noise on the placeholder path either
  });
});

describe("runCli dispatches every command inside one error handler", () => {
  // Regression (per the Scout template this closes): `mcp` and `wallet` were dispatched ABOVE
  // the try/catch, so a throw from resolveConfig/readConfigFile/peekStoredAccount escaped
  // runCli instead of becoming the same typed {error, code} line every other command produces.
  const CORRUPT = '{ "endpoint": ';

  it("a corrupt config.json on a verb path is a typed error", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentrag-verb-cfg-"));
    const err: string[] = [];
    try {
      writeFileSync(join(home, "config.json"), CORRUPT);
      const code = await runCli(["status", "my-docs"], {
        env: { AGENTRAG_HOME: home },
        stdout: sink,
        stderr: (s) => err.push(s),
      });
      expect(code).toBe(EXIT.GENERIC);
      expect(JSON.parse(err.join("")).code).toBe("invalid_config");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("runCli wallet dispatch", () => {
  it("`wallet show` reports the wallet WITHOUT minting one", async () => {
    // Dispatched before clientFromConfig, which mints a wallet on first use — so the command
    // that answers "do I have a wallet yet?" must not be the thing that creates it.
    const home = mkdtempSync(join(tmpdir(), "agentrag-wallet-cli-"));
    const out: string[] = [];
    try {
      const code = await runCli(["wallet", "show"], {
        env: { AGENTRAG_HOME: home },
        stdout: (s) => out.push(s),
        stderr: sink,
      });
      expect(code).toBe(EXIT.OK);
      expect(JSON.parse(out.join("")).address).toBeNull();
      expect(existsSync(join(home, "wallet.json"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("a malformed spend cap does not block `wallet show` (no config resolution on this path)", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentrag-wallet-cfg-"));
    const out: string[] = [];
    try {
      const code = await runCli(["wallet", "show"], {
        env: { AGENTRAG_HOME: home, AGENTRAG_MAX_SPEND_USD: "not-a-number" },
        stdout: (s) => out.push(s),
        stderr: sink,
      });
      expect(code).toBe(EXIT.OK);
      expect(JSON.parse(out.join("")).source).toBe("none");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("maps a wallet error through mapError (malformed AGENTRAG_PRIVATE_KEY -> invalid_config)", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentrag-wallet-bad-"));
    const err: string[] = [];
    try {
      const code = await runCli(["wallet", "show"], {
        env: { AGENTRAG_HOME: home, AGENTRAG_PRIVATE_KEY: "0xnope" },
        stdout: sink,
        stderr: (s) => err.push(s),
      });
      expect(code).toBe(EXIT.GENERIC);
      expect(JSON.parse(err.join("")).code).toBe("invalid_config");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("a corrupt keystore file surfaces as an error, never as a wallet address", async () => {
    // A corrupt account.json must not be reported as "wallet mode with address X" — that is a
    // silent namespace switch. The keystore's throw travels all the way out to a non-zero exit.
    const home = mkdtempSync(join(tmpdir(), "agentrag-wallet-corrupt-"));
    const out: string[] = [];
    const err: string[] = [];
    try {
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, "account.json"), "{ not json");
      const code = await runCli(["wallet", "show"], {
        env: { AGENTRAG_HOME: home },
        stdout: (s) => out.push(s),
        stderr: (s) => err.push(s),
      });
      expect(code).toBe(EXIT.GENERIC);
      expect(err.join("")).toContain("account.json");
      expect(out.join("")).toBe("");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects an unknown flag on the wallet path too (fail-closed, not silently ignored)", async () => {
    const err: string[] = [];
    const code = await runCli(["wallet", "show", "--frobnicate", "1"], {
      env: { AGENTRAG_HOME: FIXTURE_HOME },
      stdout: sink,
      stderr: (s) => err.push(s),
    });
    expect(code).toBe(EXIT.USAGE);
    expect(err.join("")).toContain("unknown flag");
  });
});

describe("runCli error -> exit-code mapping (mapError)", () => {
  it("a client throwing SpendCapError -> EXIT.PAYMENT", async () => {
    const client = {
      status: vi.fn(async () => {
        throw new SpendCapError("spend $5 exceeds per-call cap $1");
      }),
    };
    const err: string[] = [];
    const code = await runCli(["status", "my-docs"], {
      client: client as any,
      env: { AGENTRAG_HOME: FIXTURE_HOME },
      stdout: sink,
      stderr: (s) => err.push(s),
    });
    expect(code).toBe(EXIT.PAYMENT);
    expect(JSON.parse(err.join("")).code).toBe("spend_cap_exceeded");
  });

  it("an AgentRagError with status 404 -> EXIT.NOT_FOUND", async () => {
    const client = {
      status: vi.fn(async () => {
        throw new AgentRagError("AgentRag 404: not found", "collection_not_found", 404);
      }),
    };
    const err: string[] = [];
    const code = await runCli(["status", "missing"], {
      client: client as any,
      env: { AGENTRAG_HOME: FIXTURE_HOME },
      stdout: sink,
      stderr: (s) => err.push(s),
    });
    expect(code).toBe(EXIT.NOT_FOUND);
    expect(JSON.parse(err.join("")).code).toBe("collection_not_found");
  });

  it("a status-402 AgentRagError -> EXIT.PAYMENT", async () => {
    const client = {
      status: vi.fn(async () => {
        throw new AgentRagError("AgentRag 402: insufficient credits", "insufficient_credits", 402);
      }),
    };
    const code = await runCli(["status", "my-docs"], {
      client: client as any,
      env: { AGENTRAG_HOME: FIXTURE_HOME },
      stdout: sink,
      stderr: sink,
    });
    expect(code).toBe(EXIT.PAYMENT);
  });

  it("a bare AgentXError (payto_mismatch from core's caller-side pin) -> EXIT.PAYMENT", async () => {
    const client = {
      status: vi.fn(async () => {
        throw new AgentXError("challenge payTo != expectedPayTo", "payto_mismatch");
      }),
    };
    const err: string[] = [];
    const code = await runCli(["status", "my-docs"], {
      client: client as any,
      env: { AGENTRAG_HOME: FIXTURE_HOME },
      stdout: sink,
      stderr: (s) => err.push(s),
    });
    expect(code).toBe(EXIT.PAYMENT);
    expect(JSON.parse(err.join("")).code).toBe("payto_mismatch");
  });

  it("a plain thrown Error -> EXIT.GENERIC under the generic {error,code:'error'} shape", async () => {
    const client = {
      status: vi.fn(async () => {
        throw new Error("boom");
      }),
    };
    const err: string[] = [];
    const code = await runCli(["status", "my-docs"], {
      client: client as any,
      env: { AGENTRAG_HOME: FIXTURE_HOME },
      stdout: sink,
      stderr: (s) => err.push(s),
    });
    expect(code).toBe(EXIT.GENERIC);
    expect(JSON.parse(err.join("")).code).toBe("error");
  });
});

describe("runCli dispatches every verb through resolveConfig -> client construction", () => {
  it("ask", async () => {
    const client = { ask: vi.fn(async () => ({ matched: true })) };
    const out: string[] = [];
    const code = await runCli(["ask", "what is x?", "--collection", "docs"], {
      client: client as any,
      env: { AGENTRAG_HOME: FIXTURE_HOME },
      stdout: (s) => out.push(s),
      stderr: sink,
    });
    expect(code).toBe(EXIT.OK);
    expect(client.ask).toHaveBeenCalledWith(
      "what is x?",
      expect.objectContaining({ collection: "docs" }),
    );
    expect(JSON.parse(out.join("")).matched).toBe(true);
  });

  it("ingest", async () => {
    const client = { ingest: vi.fn(async () => ({ status: "complete" })) };
    const out: string[] = [];
    const code = await runCli(["ingest", "--sources", "https://ex.com/**"], {
      client: client as any,
      env: { AGENTRAG_HOME: FIXTURE_HOME },
      stdout: (s) => out.push(s),
      stderr: sink,
    });
    expect(code).toBe(EXIT.OK);
    expect(client.ingest).toHaveBeenCalledWith(
      expect.objectContaining({ sources: ["https://ex.com/**"] }),
    );
  });

  it("extend", async () => {
    const client = { extend: vi.fn(async () => ({ collection: "my-docs" })) };
    const out: string[] = [];
    const code = await runCli(["extend", "my-docs", "--days", "30"], {
      client: client as any,
      env: { AGENTRAG_HOME: FIXTURE_HOME },
      stdout: (s) => out.push(s),
      stderr: sink,
    });
    expect(code).toBe(EXIT.OK);
    expect(client.extend).toHaveBeenCalledWith("my-docs", 30);
  });

  it("status", async () => {
    const client = { status: vi.fn(async () => ({ collection: "my-docs" })) };
    const out: string[] = [];
    const code = await runCli(["status", "my-docs"], {
      client: client as any,
      env: { AGENTRAG_HOME: FIXTURE_HOME },
      stdout: (s) => out.push(s),
      stderr: sink,
    });
    expect(code).toBe(EXIT.OK);
    expect(client.status).toHaveBeenCalledWith("my-docs");
  });

  it("delete", async () => {
    const client = { delete: vi.fn(async () => ({ deleted: true })) };
    const out: string[] = [];
    const code = await runCli(["delete", "my-docs"], {
      client: client as any,
      env: { AGENTRAG_HOME: FIXTURE_HOME },
      stdout: (s) => out.push(s),
      stderr: sink,
    });
    expect(code).toBe(EXIT.OK);
    expect(client.delete).toHaveBeenCalledWith("my-docs");
  });
});

describe("runCli secret safety", () => {
  it("a configured AGENTRAG_PRIVATE_KEY never appears in stdout or stderr, even on the error path", async () => {
    const SENTINEL = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    const home = mkdtempSync(join(tmpdir(), "agentrag-cli-"));
    const out: string[] = [];
    const err: string[] = [];
    try {
      // Malformed cap -> resolveConfig throws (fail-closed) before any client is built. The key
      // is in env, so this pins that it does not leak even on the synchronous error path.
      const code = await runCli(["status", "my-docs"], {
        env: {
          AGENTRAG_HOME: home,
          AGENTRAG_PRIVATE_KEY: SENTINEL,
          AGENTRAG_MAX_SPEND_USD: "not-a-number",
        },
        stdout: (s) => out.push(s),
        stderr: (s) => err.push(s),
      });
      expect(code).not.toBe(EXIT.OK);
      expect([...out, ...err].join("")).not.toContain(SENTINEL);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("an AGENTRAG_ACCOUNT_KEY never appears in stdout or stderr on a wallet-mode error path", async () => {
    const SENTINEL = `ak_${"9".repeat(64)}`;
    const home = mkdtempSync(join(tmpdir(), "agentrag-cli-ak-"));
    const out: string[] = [];
    const err: string[] = [];
    try {
      const code = await runCli(["status", "my-docs"], {
        env: {
          AGENTRAG_HOME: home,
          AGENTRAG_ACCOUNT_KEY: SENTINEL,
          AGENTRAG_MAX_SPEND_USD: "not-a-number",
        },
        stdout: (s) => out.push(s),
        stderr: (s) => err.push(s),
      });
      expect(code).not.toBe(EXIT.OK);
      expect([...out, ...err].join("")).not.toContain(SENTINEL);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
