import { describe, it, expect } from "vitest";
import { createResumeSessionOperations, type ResumeSessionDeps } from "./resume-session";
import type { Tab } from "../../src/types/shared";

function baseTab(overrides: Partial<Tab> = {}): Tab {
  return { id: "t1", directoryId: "d1", label: "1", cwd: "/tmp", sortOrder: 0, createdAt: 0, ...overrides };
}

function harness(tab: Tab | null, spawn?: () => Promise<unknown>) {
  const plans: Array<{ tab: Tab; launchOverride?: string }> = [];
  const calls: string[] = [];
  const deps: ResumeSessionDeps = {
    getTab: () => tab,
    daemonRequest: async (method) => {
      calls.push(method);
      if (spawn) return (await spawn()) as never;
      return "sess-1" as never;
    },
    buildPlan: (t, launchOverride) => {
      plans.push({ tab: t, launchOverride });
      return { tabId: t.id, launchCommand: launchOverride };
    },
  };
  return { ops: createResumeSessionOperations(deps), plans, calls };
}

describe("createResumeSessionOperations", () => {
  it("spawns with the resume command as the launch override", async () => {
    // The override REPLACES launch_command; typing it instead would send
    // `claude --resume <id>` into an already-running claude.
    const h = harness(baseTab({ lastAgentType: "claude", lastAgentSessionId: "abc", launchCommand: "claude" }));
    await expect(h.ops.resume("t1")).resolves.toBe("sess-1");
    expect(h.calls).toEqual(["tab_spawn"]);
    expect(h.plans[0].launchOverride).toBe("claude --resume 'abc'");
  });

  it("refuses an archived tab — that is tabs_unarchive's job", async () => {
    const h = harness(baseTab({ lastAgentType: "claude", lastAgentSessionId: "abc", archivedAt: 5 }));
    await expect(h.ops.resume("t1")).rejects.toThrow("use tabs_unarchive for archived sessions");
    expect(h.calls).toEqual([]);
  });

  it("refuses when no session id was captured", async () => {
    const h = harness(baseTab({ lastAgentType: "claude" }));
    await expect(h.ops.resume("t1")).rejects.toThrow("resume unavailable");
    expect(h.calls).toEqual([]);
  });

  it("refuses an unknown agent type", async () => {
    const h = harness(baseTab({ lastAgentType: "nethack", lastAgentSessionId: "abc" }));
    await expect(h.ops.resume("t1")).rejects.toThrow("resume unavailable");
    expect(h.calls).toEqual([]);
  });

  it("throws when the tab is gone", async () => {
    const h = harness(null);
    await expect(h.ops.resume("t1")).rejects.toThrow("tab not found");
  });

  it("propagates a spawn failure", async () => {
    const h = harness(
      baseTab({ lastAgentType: "codex", lastAgentSessionId: "z" }),
      () => Promise.reject(new Error("daemon down")),
    );
    await expect(h.ops.resume("t1")).rejects.toThrow("daemon down");
  });
});
