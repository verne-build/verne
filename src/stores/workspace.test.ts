import { describe, expect, it } from "vitest";
import { shouldApplyAgentRevision } from "@/lib/agentStatus";

describe("agent status revisions", () => {
  it("rejects duplicate and stale daemon updates", () => {
    expect(shouldApplyAgentRevision(4, 4)).toBe(false);
    expect(shouldApplyAgentRevision(4, 3)).toBe(false);
    expect(shouldApplyAgentRevision(4, 5)).toBe(true);
  });

  it("accepts persisted fallback data without revisions", () => {
    expect(shouldApplyAgentRevision(undefined, undefined)).toBe(true);
    expect(shouldApplyAgentRevision(undefined, 1)).toBe(true);
  });
});
