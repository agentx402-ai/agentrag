import { describe, expect, it, vi } from "vitest";
import type { ExtendClient } from "../src/commands/extend";
import { runExtend } from "../src/commands/extend";

// Typed directly against the exported ExtendClient (the same interface the real AgentRag must
// satisfy) instead of `as never` — a mistyped override here is now a compile error.
function fakeClient(over: Partial<ExtendClient> = {}) {
  return {
    extend: vi.fn(async (collection: string, days: 30 | 60 | 90) => ({
      collection,
      days,
      expires_at: "2027-01-01T00:00:00.000Z",
    })),
    ...over,
  };
}
const io = (client: ExtendClient) => ({
  client,
  stdout: (s: string) => out.push(s),
  stderr: (s: string) => err.push(s),
});
let out: string[] = [];
let err: string[] = [];

describe("extend command", () => {
  it("requires <collection> (usage error, exit 2), never calls the client", async () => {
    out = [];
    err = [];
    const client = fakeClient();
    const code = await runExtend(["--days", "30"], io(client));
    expect(code).toBe(2);
    expect(err.join("")).toContain("collection");
    expect(client.extend).not.toHaveBeenCalled();
  });

  it("requires --days (usage error, exit 2), never calls the client", async () => {
    out = [];
    err = [];
    const client = fakeClient();
    const code = await runExtend(["my-docs"], io(client));
    expect(code).toBe(2);
    expect(err.join("")).toContain("--days");
    expect(client.extend).not.toHaveBeenCalled();
  });

  it("rejects a --days value outside {30,60,90} (usage error), never calls the client", async () => {
    out = [];
    err = [];
    const client = fakeClient();
    const code = await runExtend(["my-docs", "--days", "45"], io(client));
    expect(code).toBe(2);
    expect(err.join("")).toContain("30, 60, 90");
    expect(client.extend).not.toHaveBeenCalled();
  });

  it.each([30, 60, 90] as const)(
    "accepts --days %i and calls extend(collection, days)",
    async (days) => {
      out = [];
      err = [];
      const client = fakeClient();
      const code = await runExtend(["my-docs", "--days", String(days)], io(client));
      expect(code).toBe(0);
      expect(client.extend).toHaveBeenCalledWith("my-docs", days);
      expect(JSON.parse(out.join("")).days).toBe(days);
    },
  );

  // Review Minor: "every command accepts every other command's flags and silently drops them."
  // --sources/--collection are ask/ingest-only. runExtend itself doesn't catch parseFlags's
  // UsageError (only runCli's outer try/catch does), so this surfaces as a rejection when
  // calling runExtend directly, not a return code.
  it("rejects a flag valid on another command (e.g. --sources) instead of silently dropping it", async () => {
    out = [];
    err = [];
    const client = fakeClient();
    await expect(
      runExtend(["my-docs", "--days", "30", "--sources", "https://ex.com"], io(client)),
    ).rejects.toThrow(/flag --sources is not valid for this command/);
    expect(client.extend).not.toHaveBeenCalled();
  });
});
