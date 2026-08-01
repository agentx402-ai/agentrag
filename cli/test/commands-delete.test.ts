import { describe, expect, it, vi } from "vitest";
import { runDelete } from "../src/commands/delete";

function fakeClient(over: Record<string, unknown> = {}) {
  return {
    delete: vi.fn(async (_collection: string) => ({ deleted: true })),
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

describe("delete command", () => {
  it("requires <collection> (usage error, exit 2), never calls the client", async () => {
    out = [];
    err = [];
    const client = fakeClient();
    const code = await runDelete([], io(client));
    expect(code).toBe(2);
    expect(err.join("")).toContain("collection");
    expect((client as any).delete).not.toHaveBeenCalled();
  });

  it("deletes the named collection and prints the result", async () => {
    out = [];
    err = [];
    const client = fakeClient();
    const code = await runDelete(["my-docs"], io(client));
    expect(code).toBe(0);
    expect((client as any).delete).toHaveBeenCalledWith("my-docs");
    expect(JSON.parse(out.join("")).deleted).toBe(true);
  });
});
