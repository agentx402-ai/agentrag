import { describe, expect, it, vi } from "vitest";
import type { DeleteClient } from "../src/commands/delete";
import { runDelete } from "../src/commands/delete";

// Typed directly against the exported DeleteClient (the same interface the real AgentRag must
// satisfy) instead of `as never` — a mistyped override here is now a compile error.
function fakeClient(over: Partial<DeleteClient> = {}) {
  return {
    delete: vi.fn(async (_collection: string) => ({ deleted: true as const })),
    ...over,
  };
}
const io = (client: DeleteClient) => ({
  client,
  stdout: (s: string) => out.push(s),
  stderr: (s: string) => err.push(s),
});
let out: string[] = [];
let err: string[] = [];

describe("delete command", () => {
  it("requires <collection> (usage error, exit 2), never calls the client", async () => {
    out = [];
    err = [];
    const client = fakeClient();
    const code = await runDelete([], io(client));
    expect(code).toBe(2);
    expect(err.join("")).toContain("collection");
    expect(client.delete).not.toHaveBeenCalled();
  });

  it("deletes the named collection and prints the result", async () => {
    out = [];
    err = [];
    const client = fakeClient();
    const code = await runDelete(["my-docs"], io(client));
    expect(code).toBe(0);
    expect(client.delete).toHaveBeenCalledWith("my-docs");
    expect(JSON.parse(out.join("")).deleted).toBe(true);
  });

  // Review Minor: "every command accepts every other command's flags and silently drops them."
  // delete takes no verb-specific flags at all — anything beyond the global config flags is
  // now a usage error. runDelete doesn't catch parseFlags's UsageError itself (only runCli's
  // outer try/catch does), so this surfaces as a rejection when calling runDelete directly.
  it("rejects a flag valid on another command (e.g. --days) instead of silently dropping it", async () => {
    out = [];
    err = [];
    const client = fakeClient();
    await expect(runDelete(["my-docs", "--days", "30"], io(client))).rejects.toThrow(
      /flag --days is not valid for this command/,
    );
    expect(client.delete).not.toHaveBeenCalled();
  });
});
