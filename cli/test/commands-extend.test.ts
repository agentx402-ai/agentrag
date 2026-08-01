import { describe, expect, it, vi } from "vitest";
import { runExtend } from "../src/commands/extend";

function fakeClient(over: Record<string, unknown> = {}) {
  return {
    extend: vi.fn(async (collection: string, days: number) => ({
      collection,
      days,
      expires_at: "2027-01-01T00:00:00.000Z",
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

describe("extend command", () => {
  it("requires <collection> (usage error, exit 2), never calls the client", async () => {
    out = [];
    err = [];
    const client = fakeClient();
    const code = await runExtend(["--days", "30"], io(client));
    expect(code).toBe(2);
    expect(err.join("")).toContain("collection");
    expect((client as any).extend).not.toHaveBeenCalled();
  });

  it("requires --days (usage error, exit 2), never calls the client", async () => {
    out = [];
    err = [];
    const client = fakeClient();
    const code = await runExtend(["my-docs"], io(client));
    expect(code).toBe(2);
    expect(err.join("")).toContain("--days");
    expect((client as any).extend).not.toHaveBeenCalled();
  });

  it("rejects a --days value outside {30,60,90} (usage error), never calls the client", async () => {
    out = [];
    err = [];
    const client = fakeClient();
    const code = await runExtend(["my-docs", "--days", "45"], io(client));
    expect(code).toBe(2);
    expect(err.join("")).toContain("30, 60, 90");
    expect((client as any).extend).not.toHaveBeenCalled();
  });

  it.each([30, 60, 90])("accepts --days %i and calls extend(collection, days)", async (days) => {
    out = [];
    err = [];
    const client = fakeClient();
    const code = await runExtend(["my-docs", "--days", String(days)], io(client));
    expect(code).toBe(0);
    expect((client as any).extend).toHaveBeenCalledWith("my-docs", days);
    expect(JSON.parse(out.join("")).days).toBe(days);
  });
});
