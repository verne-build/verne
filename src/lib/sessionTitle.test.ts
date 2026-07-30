import { describe, it, expect } from "vitest";
import { sessionDisplayNameFrom, sessionTitleFrom, terminalTitleFrom } from "./sessionTitle";

describe("sessionDisplayNameFrom", () => {
  it("uses the agent title for an agent session", () => {
    expect(sessionDisplayNameFrom({
      agentType: "codex",
      generatedTitle: "Fix upload retries",
      foregroundCommand: "node",
      label: "4",
    })).toBe("Fix upload retries");
  });

  it("uses the foreground process for an ordinary terminal", () => {
    expect(sessionDisplayNameFrom({ foregroundCommand: "pnpm", label: "4" })).toBe("pnpm");
  });

  it("uses the persisted visible title for an archived terminal", () => {
    expect(sessionDisplayNameFrom({
      archived: true,
      storedDisplayTitle: "pnpm dev",
      label: "4",
    })).toBe("pnpm dev");
  });

  it("preserves an explicit rename", () => {
    expect(sessionDisplayNameFrom({
      userRenamed: true,
      label: "Logs",
      agentType: "codex",
      generatedTitle: "Fix upload retries",
    })).toBe("Logs");
  });

  it("removes an animated spinner from a pending agent title", () => {
    expect(sessionDisplayNameFrom({ agentType: "claude", oscTitle: "✳ Review auth flow" }))
      .toBe("Review auth flow");
  });

  it("preserves spinner-like glyphs in an explicit rename", () => {
    expect(sessionDisplayNameFrom({
      userRenamed: true,
      label: "★ Production",
      agentType: "claude",
      oscTitle: "✳ Pending",
    })).toBe("★ Production");
  });
});

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

  it("a live runtime displayTitle beats the persisted one", () => {
    expect(sessionTitleFrom({
      displayTitle: "Live", storedDisplayTitle: "Stored", agentType: "claude",
    })).toBe("Live");
  });

  it("the persisted title takes over once the daemon is gone", () => {
    // The whole point: an archived or post-restart session has no runtime
    // displayTitle and no OSC title, and used to collapse to "Claude".
    expect(sessionTitleFrom({
      storedDisplayTitle: "Fix the uploader", agentType: "claude",
    })).toBe("Fix the uploader");
  });

  it("the persisted title still loses to a generated title and a rename", () => {
    expect(sessionTitleFrom({
      generatedTitle: "Generated", storedDisplayTitle: "Stored",
    })).toBe("Generated");
    expect(sessionTitleFrom({
      userRenamed: true, label: "Mine", storedDisplayTitle: "Stored",
    })).toBe("Mine");
  });

  it("the persisted title beats a live OSC title", () => {
    expect(sessionTitleFrom({ storedDisplayTitle: "Stored", oscTitle: "Osc" })).toBe("Stored");
  });
});

describe("terminalTitleFrom", () => {
  it("prefers a user rename", () => {
    expect(terminalTitleFrom({ userRenamed: true, label: "build", foregroundCommand: "vim" })).toBe("build");
  });
  it("ignores a label the user did not set", () => {
    expect(terminalTitleFrom({ label: "2", foregroundCommand: "vim" })).toBe("vim");
  });
  it("names the agent when one owns the tab", () => {
    expect(terminalTitleFrom({ agentType: "claude", foregroundCommand: "node" })).toBe("Claude");
  });
  it("uses the foreground command", () => {
    expect(terminalTitleFrom({ foregroundCommand: "pnpm" })).toBe("pnpm");
  });
  it("strips the login-shell dash", () => {
    expect(terminalTitleFrom({ foregroundCommand: "-zsh" })).toBe("zsh");
  });
  it("falls back to the shell name when nothing is running", () => {
    expect(terminalTitleFrom({})).toBe("zsh");
    expect(terminalTitleFrom({ foregroundCommand: "" })).toBe("zsh");
  });
});
