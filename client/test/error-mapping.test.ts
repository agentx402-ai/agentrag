import { describe, expect, it } from "vitest";
import { AgentRagError, ragErrorFromResponse } from "../src/errors";

describe("ragErrorFromResponse code -> status mapping", () => {
  it.each([
    ["collection_not_found", 404],
    ["collection_expired", 410],
    ["insufficient_credits", 402],
    ["invalid_request", 400],
    ["rate_limited", 429],
  ] as const)("preserves worker code %s with status %i", async (code, status) => {
    const res = new Response(JSON.stringify({ error: code, code }), {
      status,
    });
    const e = await ragErrorFromResponse(res, "op failed");
    expect(e).toBeInstanceOf(AgentRagError);
    expect(e.code).toBe(code);
    expect(e.status).toBe(status);
  });
});
