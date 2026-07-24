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

  it.each([
    null,
    { agentType: "claude", modelId: "sonnet", effort: "medium" },
    { agentType: "codex", modelId: "gpt-5.6-sol", effort: "medium", fast: "false" },
    { agentType: "claude", modelId: 1, effort: null, fast: null },
    { agentType: "claude", modelId: "sonnet", effort: false, fast: null },
    { agentType: "claude", modelId: "sonnet", effort: null, fast: null, command: "codex" },
  ])("rejects malformed runtime selections: %j", (selection) => {
    expect(() => resolveLaunchCommand(selection as any)).toThrow("Invalid agent launch selection");
  });

  it("validates agent types after validating their runtime shape", () => {
    expect(() => resolveLaunchCommand({ agentType: "shell", modelId: null, effort: null, fast: null } as any))
      .toThrow("Unknown agent type");
  });
});
