import { describe, expect, it, vi } from "vitest";
import { runStatus } from "../src/commands/status";

function fakeClient(over: Record<string, unknown> = {}) {
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
  } as never;
}
const io = (client: never) => ({
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
    expect((client as any).status).not.toHaveBeenCalled();
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
});
