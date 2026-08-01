import { AgentXError } from "@agentx402-ai/core";
import { describe, expect, it } from "vitest";
import { AgentRagError, ragErrorFromResponse, SpendCapError } from "../src/errors";

describe("AgentRag error taxonomy", () => {
  it("re-exports the SAME core AgentXError class (cross-package instanceof holds)", async () => {
    const core = await import("@agentx402-ai/core");
    expect(AgentXError).toBe(core.AgentXError);
  });

  it("re-exports core's own SpendCapError class object, not a copy", async () => {
    const core = await import("@agentx402-ai/core");
    expect(SpendCapError).toBe(core.SpendCapError);
    expect(new SpendCapError("x")).toBeInstanceOf(core.AgentXError);
  });

  it("AgentRagError carries code, status, and hint, and is an AgentXError", () => {
    const e = new AgentRagError("expired", "collection_expired", 410, "extend before it slides");
    expect(e).toBeInstanceOf(AgentXError);
    expect(e.code).toBe("collection_expired");
    expect(e.status).toBe(410);
    expect(e.hint).toBe("extend before it slides");
    expect(e.name).toBe("AgentRagError");
  });

  it("ragErrorFromResponse maps a { error, code, hint } body to code+hint+status", async () => {
    const res = new Response(
      JSON.stringify({
        error: "collection not found",
        code: "collection_not_found",
        hint: "check the collection id",
      }),
      { status: 404 },
    );
    const e = await ragErrorFromResponse(res, "ask failed");
    expect(e).toBeInstanceOf(AgentRagError);
    expect(e.code).toBe("collection_not_found");
    expect(e.status).toBe(404);
    expect(e.hint).toBe("check the collection id");
    expect(e.message).toContain("collection not found");
  });

  it("falls back to request_failed when the body carries no code", async () => {
    const res = new Response("<html>502 bad gateway</html>", { status: 502 });
    const e = await ragErrorFromResponse(res, "ask failed");
    expect(e.code).toBe("request_failed");
    expect(e.status).toBe(502);
    expect(e.hint).toBeUndefined();
    expect(e.message).toContain("ask failed");
  });
});
