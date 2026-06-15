import { describe, expect, it } from "vitest";
import { agentLabel, notifyKind, notifyMessage } from "@/lib/agentNotifications";

describe("notifyKind", () => {
  it("fires blocked on any → blocked edge", () => {
    expect(notifyKind(undefined, "blocked")).toBe("blocked");
    expect(notifyKind("working", "blocked")).toBe("blocked");
    expect(notifyKind("idle", "blocked")).toBe("blocked");
  });

  it("ignores repeated blocked", () => {
    expect(notifyKind("blocked", "blocked")).toBeNull();
  });

  it("fires finished only on working → idle", () => {
    expect(notifyKind("working", "idle")).toBe("finished");
    expect(notifyKind("blocked", "idle")).toBeNull();
    expect(notifyKind(undefined, "idle")).toBeNull();
  });

  // Refocus regression: with state recorded on every event (even unfocused),
  // the away working → blocked edge is consumed; the refocus blocked event is
  // blocked → blocked and must not re-toast.
  it("refocus after away transition yields no duplicate", () => {
    expect(notifyKind("working", "blocked")).toBe("blocked"); // away
    expect(notifyKind("blocked", "blocked")).toBeNull(); // refocus
  });
});

describe("notifyMessage", () => {
  it("matches OS notification titles", () => {
    expect(notifyMessage("blocked", "claude")).toBe("Claude needs your input");
    expect(notifyMessage("finished", "codex")).toBe("Codex finished");
  });
});

describe("agentLabel", () => {
  it("maps every detection-manifest agent id", () => {
    const expected: Record<string, string> = {
      amp: "Amp",
      antigravity: "Antigravity",
      claude: "Claude",
      cline: "Cline",
      codex: "Codex",
      copilot: "Copilot",
      cursor: "Cursor",
      droid: "Droid",
      gemini: "Gemini",
      grok: "Grok",
      hermes: "Hermes",
      kilo: "Kilo",
      kimi: "Kimi",
      kiro: "Kiro",
      opencode: "OpenCode",
      pi: "Pi",
      qodercli: "Qoder",
    };
    for (const [id, label] of Object.entries(expected)) expect(agentLabel(id)).toBe(label);
  });

  it("passes through unknown types", () => {
    expect(agentLabel("someagent")).toBe("someagent");
  });
});
