import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_REGISTRY,
  filterAvailableAgents,
  loadAvailableAgents,
  resetAgentAvailabilityCacheForTests,
} from "./agentRegistry";
import { findAgentIconForSurface } from "@/composables/useAgentIcon";

describe("agent registry", () => {
  beforeEach(() => resetAgentAvailabilityCacheForTests());

  it("defines the confirmed picker order and launch binaries", () => {
    expect(AGENT_REGISTRY).toEqual([
      { type: "claude", label: "Claude", bin: "claude" },
      { type: "codex", label: "Codex", bin: "codex" },
      { type: "copilot", label: "Copilot", bin: "copilot" },
      { type: "opencode", label: "OpenCode", bin: "opencode" },
      { type: "gemini", label: "Gemini", bin: "gemini" },
      { type: "cursor", label: "Cursor", bin: "cursor-agent" },
    ]);
  });

  it("filters by binary while retaining registry order", () => {
    expect(filterAvailableAgents(["cursor-agent", "codex", "missing"]).map((a) => a.type))
      .toEqual(["codex", "cursor"]);
  });

  it("caches availability for five minutes", async () => {
    const fetcher = vi.fn(async () => ({ available: ["codex"] }));
    await loadAvailableAgents(fetcher, 1_000);
    await loadAvailableAgents(fetcher, 1_000 + 299_999);
    await loadAvailableAgents(fetcher, 1_000 + 300_001);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("returns no asset for iconless registry types", () => {
    expect(findAgentIconForSurface("gemini", "dark")).toBeUndefined();
    expect(findAgentIconForSurface("cursor", "light")).toBeUndefined();
  });
});
