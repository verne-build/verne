import { describe, it, expect } from "vitest";
import { bareLaunchCommand, bracketedPaste } from "./reviewLaunch";

describe("bareLaunchCommand", () => {
  it("returns the bare binary for each agent", () => {
    expect(bareLaunchCommand("claude")).toBe("claude");
    expect(bareLaunchCommand("codex")).toBe("codex");
    expect(bareLaunchCommand("cursor")).toBe("cursor-agent");
    expect(bareLaunchCommand("opencode")).toBe("opencode");
  });
});

describe("bracketedPaste", () => {
  it("wraps text in paste-mode control sequences", () => {
    expect(bracketedPaste("hi")).toBe("\x1b[200~hi\x1b[201~");
  });
  it("keeps multi-line content intact between the markers", () => {
    expect(bracketedPaste("a\nb")).toBe("\x1b[200~a\nb\x1b[201~");
  });
});
