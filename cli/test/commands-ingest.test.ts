import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runIngest } from "../src/commands/ingest";

function fakeClient(over: Record<string, unknown> = {}) {
  return {
    ingest: vi.fn(async (o?: Record<string, unknown>) => ({
      collection: "docs",
      status: "complete",
      opts: o,
    })),
    ...over,
  } as never;
}
const io = (client: never) => ({
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
    expect((client as any).ingest).toHaveBeenCalledWith(
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
    expect((client as any).ingest).toHaveBeenCalledWith(
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
      expect((client as any).ingest).toHaveBeenCalledWith(expect.objectContaining({ documents }));
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
    expect((client as any).ingest).not.toHaveBeenCalled();
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
      expect((client as any).ingest).not.toHaveBeenCalled();
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
      expect((client as any).ingest).not.toHaveBeenCalled();
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
});
