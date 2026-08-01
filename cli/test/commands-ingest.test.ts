import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IngestOptions } from "@agentrag/client";
import { describe, expect, it, vi } from "vitest";
import type { IngestClient } from "../src/commands/ingest";
import { runIngest } from "../src/commands/ingest";

// Typed directly against the exported IngestClient (the same interface the real AgentRag must
// satisfy) instead of `as never` — a mistyped override here is now a compile error.
function fakeClient(over: Partial<IngestClient> = {}) {
  return {
    ingest: vi.fn(async (o?: IngestOptions) => ({
      collection: "docs",
      status: "complete",
      opts: o,
    })),
    ...over,
  };
}
const io = (client: IngestClient) => ({
  client,
  stdout: (s: string) => out.push(s),
  stderr: (s: string) => err.push(s),
});
let out: string[] = [];
let err: string[] = [];

describe("ingest command", () => {
  it("ingests sources and prints the result", async () => {
    out = [];
    err = [];
    const client = fakeClient();
    const code = await runIngest(["--sources", "https://ex.com/**"], io(client));
    expect(code).toBe(0);
    expect(client.ingest).toHaveBeenCalledWith(
      expect.objectContaining({ sources: ["https://ex.com/**"] }),
    );
    expect(JSON.parse(out.join("")).status).toBe("complete");
  });

  it("passes collection/model/maxPages/refresh through", async () => {
    out = [];
    err = [];
    const client = fakeClient();
    const code = await runIngest(
      [
        "--sources",
        "https://ex.com/**",
        "--collection",
        "docs",
        "--model",
        "@cf/baai/bge-m3",
        "--max-pages",
        "15",
        "--refresh",
      ],
      io(client),
    );
    expect(code).toBe(0);
    expect(client.ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        sources: ["https://ex.com/**"],
        collection: "docs",
        model: "@cf/baai/bge-m3",
        maxPages: 15,
        refresh: true,
      }),
    );
  });

  it("--documents FILE loads a JSON array of documents from disk", async () => {
    out = [];
    err = [];
    const dir = mkdtempSync(join(tmpdir(), "agentrag-ingest-docs-"));
    const file = join(dir, "docs.json");
    try {
      const documents = [{ text: "Refunds are available within 30 days.", title: "Refunds" }];
      writeFileSync(file, JSON.stringify(documents));
      const client = fakeClient();
      const code = await runIngest(["--documents", file, "--collection", "docs"], io(client));
      expect(code).toBe(0);
      expect(client.ingest).toHaveBeenCalledWith(expect.objectContaining({ documents }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--documents pointing at a missing file -> usage error (exit 2), no network call", async () => {
    out = [];
    err = [];
    const client = fakeClient();
    const code = await runIngest(["--documents", "/no/such/file.json"], io(client));
    expect(code).toBe(2);
    expect(err.join("")).toContain("--documents");
    expect(client.ingest).not.toHaveBeenCalled();
  });

  it("--documents pointing at invalid JSON -> usage error (exit 2), no network call", async () => {
    out = [];
    err = [];
    const dir = mkdtempSync(join(tmpdir(), "agentrag-ingest-baddocs-"));
    const file = join(dir, "docs.json");
    try {
      writeFileSync(file, "{ not json");
      const client = fakeClient();
      const code = await runIngest(["--documents", file], io(client));
      expect(code).toBe(2);
      expect(err.join("")).toContain("valid JSON");
      expect(client.ingest).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--documents pointing at a JSON object (not an array) -> usage error, no network call", async () => {
    out = [];
    err = [];
    const dir = mkdtempSync(join(tmpdir(), "agentrag-ingest-objdocs-"));
    const file = join(dir, "docs.json");
    try {
      writeFileSync(file, JSON.stringify({ text: "not an array" }));
      const client = fakeClient();
      const code = await runIngest(["--documents", file], io(client));
      expect(code).toBe(2);
      expect(err.join("")).toContain("array");
      expect(client.ingest).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prints a 202 AskPending result as-is (a large source set needs a durable job)", async () => {
    out = [];
    err = [];
    const client = fakeClient({
      ingest: vi.fn(async () => ({
        collection: "docs",
        status: "ingesting",
        retry_after: 5,
      })),
    });
    const code = await runIngest(["--sources", "https://ex.com/**"], io(client));
    expect(code).toBe(0);
    expect(JSON.parse(out.join("")).status).toBe("ingesting");
  });

  // Review Minor: "every command accepts every other command's flags and silently drops them."
  // --wait/--top-k/--mode are ask-only; --days is extend-only. runIngest itself doesn't catch
  // parseFlags's UsageError (only runCli's outer try/catch does), so this surfaces as a
  // rejection when calling runIngest directly, not a return code.
  it("rejects a flag valid on another command (e.g. --wait, --days) instead of silently dropping it", async () => {
    out = [];
    err = [];
    const client = fakeClient();
    await expect(runIngest(["--sources", "https://ex.com", "--wait"], io(client))).rejects.toThrow(
      /flag --wait is not valid for this command/,
    );
    await expect(
      runIngest(["--sources", "https://ex.com", "--days", "30"], io(client)),
    ).rejects.toThrow(/flag --days is not valid for this command/);
    expect(client.ingest).not.toHaveBeenCalled();
  });
});
