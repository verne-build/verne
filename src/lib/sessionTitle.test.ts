import { describe, it, expect } from "vitest";
import { sessionTitleFrom } from "./sessionTitle";

describe("sessionTitleFrom", () => {
  it("a manual rename beats everything", () => {
    expect(sessionTitleFrom({
      userRenamed: true, label: "My Session",
      generatedTitle: "Generated", displayTitle: "Hook", oscTitle: "Osc", agentType: "codex",
    })).toBe("My Session");
  });

  it("a generated title beats displayTitle, OSC and the agent name", () => {
    // Without this the feature is pointless: codex would show its OSC title or
    // "Codex" forever instead of the title we generated.
    expect(sessionTitleFrom({
      generatedTitle: "Retry the uploader",
      displayTitle: "Hook", oscTitle: "Osc", agentType: "codex",
    })).toBe("Retry the uploader");
  });

  it("OSC is the pending name while no generated title exists", () => {
    expect(sessionTitleFrom({ oscTitle: "Osc", agentType: "codex" })).toBe("Osc");
  });

  it("falls back to a title-cased agent name", () => {
    expect(sessionTitleFrom({ agentType: "codex" })).toBe("Codex");
  });

  it("then the foreground command, then the label, then shell", () => {
    expect(sessionTitleFrom({ foregroundCommand: "vim" })).toBe("vim");
    expect(sessionTitleFrom({ label: "3" })).toBe("3");
    expect(sessionTitleFrom({})).toBe("shell");
  });

  it("ignores an empty label on a renamed tab", () => {
    expect(sessionTitleFrom({ userRenamed: true, label: "", agentType: "codex" })).toBe("Codex");
  });
});
