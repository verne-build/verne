import { describe, it, expect } from "vitest";
import { bareLaunchCommand, bracketedPaste, sanitizeBracketedPaste, pasteReadiness } from "./reviewLaunch";

describe("bareLaunchCommand", () => {
  it("prefixes update-suppression env so the agent's self-updater can't run", () => {
    // A pending update otherwise blocks startup (~10s) and its prompt eats the
    // pasted review. `env` keeps it shell-agnostic (zsh/bash/fish).
    expect(bareLaunchCommand("claude")).toBe("env DISABLE_AUTOUPDATER=1 claude");
    expect(bareLaunchCommand("codex")).toBe("env CODEX_CI=1 codex");
  });

  it("maps the binary name and leaves agents without an updater override bare", () => {
    expect(bareLaunchCommand("cursor")).toBe("cursor-agent");
    expect(bareLaunchCommand("opencode")).toBe("opencode");
  });
});

describe("pasteReadiness", () => {
  it("treats codex as buffered (paste immediately) and claude as settle", () => {
    expect(pasteReadiness("codex")).toBe("buffered");
    expect(pasteReadiness("claude")).toBe("settle");
  });
  it("defaults uncharacterised agents to the safe settle path", () => {
    expect(pasteReadiness("opencode")).toBe("settle");
    expect(pasteReadiness("cursor")).toBe("settle");
  });
});

describe("bracketedPaste", () => {
  it("wraps text in paste-mode control sequences", () => {
    expect(bracketedPaste("hi")).toBe("\x1b[200~hi\x1b[201~");
  });
  it("keeps multi-line content intact between the markers", () => {
    expect(bracketedPaste("a\nb")).toBe("\x1b[200~a\nb\x1b[201~");
  });
  it("strips embedded markers so they can't terminate the paste early", () => {
    expect(bracketedPaste("a\x1b[201~b")).toBe("\x1b[200~ab\x1b[201~");
  });
});

describe("sanitizeBracketedPaste", () => {
  it("removes start and end markers, leaving other bytes intact", () => {
    expect(sanitizeBracketedPaste("x\x1b[200~y\x1b[201~z")).toBe("xyz");
  });
  it("is a no-op for content without markers", () => {
    expect(sanitizeBracketedPaste("plain\ntext")).toBe("plain\ntext");
  });
});
