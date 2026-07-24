import { describe, expect, it } from "vitest";
import { resolveLaunchCommand } from "./agent-launch";

describe("resolveLaunchCommand", () => {
  it("returns undefined for Terminal", () => {
    expect(resolveLaunchCommand()).toBeUndefined();
  });

  it("builds a validated command", () => {
    expect(resolveLaunchCommand({ agentType: "claude", modelId: "sonnet", effort: "medium", fast: null }))
      .toBe("claude --model sonnet --effort medium");
  });

  it("rejects renderer-manipulated values", () => {
    expect(() => resolveLaunchCommand({ agentType: "claude", modelId: "sonnet; touch /tmp/pwn", effort: null, fast: null } as any))
      .toThrow("Unknown Claude model");
  });
});
