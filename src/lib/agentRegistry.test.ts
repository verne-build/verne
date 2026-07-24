import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_REGISTRY,
  buildAgentArgv,
  filterAvailableAgents,
  getModelDefinition,
  loadAvailableAgents,
  resetAgentAvailabilityCacheForTests,
  serializeArgv,
} from "./agentRegistry";
import { findAgentIconForSurface } from "@/composables/useAgentIcon";

describe("agent registry", () => {
  beforeEach(() => resetAgentAvailabilityCacheForTests());

  it("uses the approved launch agents and excludes Copilot", () => {
    expect(AGENT_REGISTRY.map(({ type, bin }) => [type, bin])).toEqual([
      ["claude", "claude"], ["codex", "codex"], ["opencode", "opencode"],
      ["agy", "agy"], ["cursor", "cursor-agent"],
    ]);
  });

  it("presents agy as Antigravity with the existing agent icon", () => {
    expect(AGENT_REGISTRY.find(({ type }) => type === "agy")?.label).toBe("Antigravity");
    expect(findAgentIconForSurface("agy", "dark"))
      .toBe(findAgentIconForSurface("antigravity", "dark"));
  });

  it("omits default categories", () => {
    expect(buildAgentArgv({ agentType: "claude", modelId: null, effort: null, fast: null }))
      .toEqual(["claude"]);
  });

  it("serializes representative commands", () => {
    expect(buildAgentArgv({ agentType: "claude", modelId: "sonnet", effort: "medium", fast: null }))
      .toEqual(["claude", "--model", "sonnet", "--effort", "medium"]);
    expect(buildAgentArgv({ agentType: "agy", modelId: "Claude Sonnet 4.6 (Thinking)", effort: null, fast: null }))
      .toEqual(["agy", "--model", "Claude Sonnet 4.6 (Thinking)"]);
    expect(serializeArgv(["agy", "--model", "Claude Sonnet 4.6 (Thinking)"]))
      .toBe("agy --model 'Claude Sonnet 4.6 (Thinking)'");
  });

  it("rejects stale and incompatible selections", () => {
    expect(() => buildAgentArgv({ agentType: "agy", modelId: "missing", effort: null, fast: null })).toThrow("Unknown Antigravity model");
    expect(() => buildAgentArgv({ agentType: "claude", modelId: "sonnet", effort: "medium", fast: true })).toThrow("Fast mode is unavailable");
    expect(() => buildAgentArgv({ agentType: "copilot", modelId: null, effort: null, fast: null } as any)).toThrow("Unknown agent type");
  });

  it("exposes controls only for supported combinations", () => {
    expect(getModelDefinition("agy", "Claude Sonnet 4.6 (Thinking)")?.efforts).toBeUndefined();
    expect(getModelDefinition("claude", "sonnet")?.fast).toBeUndefined();
    expect(getModelDefinition("claude", "opus")?.fast).toBe("claude-settings");
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
    expect(fetcher).not.toHaveBeenCalledWith(expect.arrayContaining(["copilot"]));
  });

  it("returns no asset for iconless registry types", () => {
    expect(findAgentIconForSurface("cursor", "light")).toBeUndefined();
  });
});
