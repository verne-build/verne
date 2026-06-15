import { describe, expect, it } from "vitest";
import { resolveDisplayState, aggregateGroupState } from "@/lib/agentStatus";

describe("resolveDisplayState", () => {
  it("acknowledgement wins over state", () => {
    expect(resolveDisplayState({ needsAcknowledgement: true, agentState: "working", agentType: "claude" })).toBe("done");
  });

  it("passes through valid states", () => {
    expect(resolveDisplayState({ agentState: "working", agentType: "claude" })).toBe("working");
    expect(resolveDisplayState({ agentState: "blocked", agentType: "codex" })).toBe("blocked");
  });

  it("maps invalid/missing state to unknown when agentType present", () => {
    expect(resolveDisplayState({ agentState: undefined, agentType: "claude" })).toBe("unknown");
    expect(resolveDisplayState({ agentState: "bogus", agentType: "claude" })).toBe("unknown");
  });

  it("returns null when agentType required but missing", () => {
    expect(resolveDisplayState({ agentState: "working", agentType: null, requireAgentType: true })).toBeNull();
  });

  it("returns the state (not null) when agentType not required and missing", () => {
    expect(resolveDisplayState({ agentState: "working", agentType: null })).toBe("working");
  });
});

describe("aggregateGroupState", () => {
  it("prioritises blocked > done > working > idle > unknown", () => {
    expect(aggregateGroupState(["idle", "working", "blocked"])).toBe("blocked");
    expect(aggregateGroupState(["idle", "done", "working"])).toBe("done");
    expect(aggregateGroupState(["idle", "working"])).toBe("working");
    expect(aggregateGroupState(["unknown", "idle"])).toBe("idle");
  });

  it("ignores nulls and returns null when empty", () => {
    expect(aggregateGroupState([null, null])).toBeNull();
    expect(aggregateGroupState([])).toBeNull();
  });
});
