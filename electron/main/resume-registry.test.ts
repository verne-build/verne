import { describe, it, expect } from "vitest";
import { resumeCommand, canResumeAgent } from "./resume-registry";

describe("resumeCommand", () => {
  it("builds a shell-safe claude resume command", () => {
    expect(resumeCommand("claude", "abc-123")).toBe("claude --resume 'abc-123'");
  });

  it("builds the interactive codex resume command (not `codex exec resume`)", () => {
    expect(resumeCommand("codex", "abc-123")).toBe("codex resume 'abc-123'");
  });

  it("returns undefined for an unknown agent type", () => {
    expect(resumeCommand("definitely-not-an-agent", "abc-123")).toBeUndefined();
  });

  it("returns undefined when the agent type is missing", () => {
    expect(resumeCommand(undefined, "abc-123")).toBeUndefined();
  });

  it("returns undefined when the session id is missing", () => {
    expect(resumeCommand("claude", undefined)).toBeUndefined();
  });

  it("safely quotes a session id containing a single quote", () => {
    expect(resumeCommand("claude", "a'b")).toBe(`claude --resume 'a'"'"'b'`);
  });
});

describe("canResumeAgent", () => {
  it("is true for a registered agent with a session id", () => {
    expect(canResumeAgent("claude", "abc-123")).toBe(true);
    expect(canResumeAgent("codex", "abc-123")).toBe(true);
  });

  it("is false for an unknown agent", () => {
    expect(canResumeAgent("definitely-not-an-agent", "abc-123")).toBe(false);
  });

  it("is false when the session id is missing", () => {
    expect(canResumeAgent("claude", undefined)).toBe(false);
  });

  it("is false when the agent type is missing", () => {
    expect(canResumeAgent(undefined, "abc-123")).toBe(false);
  });
});
