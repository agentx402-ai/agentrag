import { describe, expect, it, vi } from "vitest";
import type { StatusClient } from "../src/commands/status";
import { runStatus } from "../src/commands/status";

// Typed directly against the exported StatusClient (the same interface the real AgentRag must
// satisfy) instead of `as never` — a mistyped override here is now a compile error.
function fakeClient(over: Partial<StatusClient> = {}) {
  return {
    status: vi.fn(async (collection: string) => ({
      collection,
      model: "@cf/baai/bge-m3",
      pages: 3,
      chunks: 42,
      created_at: "2026-01-01T00:00:00.000Z",
      expires_at: "2027-01-01T00:00:00.000Z",
    })),
    ...over,
  };
}
const io = (client: StatusClient) => ({
  client,
  stdout: (s: string) => out.push(s),
  stderr: (s: string) => err.push(s),
});
let out: string[] = [];
let err: string[] = [];

describe("status command", () => {
  it("requires <collection> (usage error, exit 2), never calls the client", async () => {
    out = [];
    err = [];
    const client = fakeClient();
    const code = await runStatus([], io(client));
    expect(code).toBe(2);
    expect(err.join("")).toContain("collection");
    expect(client.status).not.toHaveBeenCalled();
  });

  it("prints the collection's status", async () => {
    out = [];
    err = [];
    const code = await runStatus(["my-docs"], io(fakeClient()));
    expect(code).toBe(0);
    const printed = JSON.parse(out.join(""));
    expect(printed.collection).toBe("my-docs");
    expect(printed.chunks).toBe(42);
  });

  // Review Minor: "every command accepts every other command's flags and silently drops them."
  // status takes no verb-specific flags at all — anything beyond the global config flags is
  // now a usage error. runStatus doesn't catch parseFlags's UsageError itself (only runCli's
  // outer try/catch does), so this surfaces as a rejection when calling runStatus directly.
  it("rejects a flag valid on another command (e.g. --top-k) instead of silently dropping it", async () => {
    out = [];
    err = [];
    const client = fakeClient();
    await expect(runStatus(["my-docs", "--top-k", "5"], io(client))).rejects.toThrow(
      /flag --top-k is not valid for this command/,
    );
    expect(client.status).not.toHaveBeenCalled();
  });
});
