import type { AskOptions } from "@agentrag/client";
import { describe, expect, it, vi } from "vitest";
import type { AskClient } from "../src/commands/ask";
import { runAsk } from "../src/commands/ask";

// Typed directly against the exported AskClient (the same interface the real AgentRag must
// satisfy) instead of `as never` — a mistyped override here is now a compile error, and
// `client.ask`/`client.askAndWait` below are the real vi.fn() mocks, not an erased `any`.
function fakeClient(over: Partial<AskClient> = {}) {
  return {
    ask: vi.fn(async (query: string, o?: AskOptions) => ({
      collection: "docs",
      matched: true,
      chunks: [],
      query,
      opts: o,
    })),
    askAndWait: vi.fn(async (query: string, o?: AskOptions) => ({
      collection: "docs",
      matched: true,
      chunks: [],
      query,
      opts: o,
    })),
    ...over,
  };
}
const io = (client: AskClient) => ({
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
    expect(client.ask).not.toHaveBeenCalled();
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

  it("rejects an unquoted multi-word query instead of paying for the wrong (first) word", async () => {
    // `agentrag ask what is x` arrives as three positionals; the pre-fix CLI paid for the ask
    // "what". Reject it with a usage error and never touch the (spending) client.
    out = [];
    err = [];
    const client = fakeClient();
    const code = await runAsk(["what", "is", "x"], io(client));
    expect(code).toBe(2); // EXIT.USAGE
    expect(err.join("")).toMatch(/ask takes a single <query>/);
    expect(client.ask).not.toHaveBeenCalled();
    expect(client.askAndWait).not.toHaveBeenCalled();
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
    expect(client.ask).toHaveBeenCalledWith("what is x?", {
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
    expect(client.askAndWait).toHaveBeenCalledTimes(1);
    expect(client.ask).not.toHaveBeenCalled();
  });

  it("without --wait, ask() is called and askAndWait is not", async () => {
    out = [];
    err = [];
    const client = fakeClient();
    const code = await runAsk(["what is x?"], io(client));
    expect(code).toBe(0);
    expect(client.ask).toHaveBeenCalledTimes(1);
    expect(client.askAndWait).not.toHaveBeenCalled();
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

  // Review Minor: "every command accepts every other command's flags and silently drops them."
  // --refresh/--days/--documents/--model are real flags elsewhere (ingest/extend) but not part
  // of ask's own surface — this is now a usage error rather than a silent no-op. runAsk itself
  // doesn't catch parseFlags's UsageError (only runCli's outer try/catch does — see cli.ts),
  // so calling it directly here surfaces as a rejected promise, not a return code; that
  // mapping to EXIT.USAGE is exercised separately at the runCli level.
  it("rejects a flag valid on another command (e.g. --refresh, --days) instead of silently dropping it", async () => {
    out = [];
    err = [];
    const client = fakeClient();
    await expect(runAsk(["what is x?", "--refresh"], io(client))).rejects.toThrow(
      /flag --refresh is not valid for this command/,
    );
    await expect(runAsk(["what is x?", "--days", "30"], io(client))).rejects.toThrow(
      /flag --days is not valid for this command/,
    );
    expect(client.ask).not.toHaveBeenCalled();
  });
});
