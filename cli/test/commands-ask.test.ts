import { describe, expect, it, vi } from "vitest";
import { runAsk } from "../src/commands/ask";

function fakeClient(over: Record<string, unknown> = {}) {
  return {
    ask: vi.fn(async (query: string, o?: Record<string, unknown>) => ({
      collection: "docs",
      matched: true,
      chunks: [],
      query,
      opts: o,
    })),
    askAndWait: vi.fn(async (query: string, o?: Record<string, unknown>) => ({
      collection: "docs",
      matched: true,
      chunks: [],
      query,
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

describe("ask command", () => {
  it("requires <query> (usage error, exit 2) and never calls the client", async () => {
    out = [];
    err = [];
    const client = fakeClient();
    const code = await runAsk([], io(client));
    expect(code).toBe(2);
    expect(err.join("")).toContain("query");
    expect((client as any).ask).not.toHaveBeenCalled();
  });

  it("asks the query and prints the result", async () => {
    out = [];
    err = [];
    const code = await runAsk(["what is x?"], io(fakeClient()));
    expect(code).toBe(0);
    const printed = JSON.parse(out.join(""));
    expect(printed.matched).toBe(true);
    expect(printed.query).toBe("what is x?");
  });

  it("passes sources/collection/topK/mode/maxPages through to ask()", async () => {
    out = [];
    err = [];
    const client = fakeClient();
    const code = await runAsk(
      [
        "what is x?",
        "--sources",
        "https://a.example",
        "--sources",
        "https://b.example",
        "--collection",
        "docs",
        "--top-k",
        "5",
        "--mode",
        "hybrid",
        "--max-pages",
        "10",
      ],
      io(client),
    );
    expect(code).toBe(0);
    expect((client as any).ask).toHaveBeenCalledWith("what is x?", {
      sources: ["https://a.example", "https://b.example"],
      collection: "docs",
      topK: 5,
      mode: "hybrid",
      maxPages: 10,
    });
  });

  it("--wait calls askAndWait instead of ask", async () => {
    out = [];
    err = [];
    const client = fakeClient();
    const code = await runAsk(["what is x?", "--wait"], io(client));
    expect(code).toBe(0);
    expect((client as any).askAndWait).toHaveBeenCalledTimes(1);
    expect((client as any).ask).not.toHaveBeenCalled();
  });

  it("without --wait, ask() is called and askAndWait is not", async () => {
    out = [];
    err = [];
    const client = fakeClient();
    const code = await runAsk(["what is x?"], io(client));
    expect(code).toBe(0);
    expect((client as any).ask).toHaveBeenCalledTimes(1);
    expect((client as any).askAndWait).not.toHaveBeenCalled();
  });

  it("prints a 202 AskPending result as-is (no special-casing in the CLI layer)", async () => {
    out = [];
    err = [];
    const client = fakeClient({
      ask: vi.fn(async () => ({
        collection: "docs",
        status: "ingesting",
        retry_after: 5,
      })),
    });
    const code = await runAsk(["what is x?", "--sources", "https://a.example"], io(client));
    expect(code).toBe(0);
    expect(JSON.parse(out.join("")).status).toBe("ingesting");
  });
});
