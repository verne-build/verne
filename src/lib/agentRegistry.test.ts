import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_REGISTRY,
  buildAgentArgv,
  filterAvailableAgents,
  getAgentDefinition,
  getModelDefinition,
  loadAvailableAgents,
  resetAgentAvailabilityCacheForTests,
  serializeArgv,
  effortsFor,
  supportsFastFor,
  tuningLabel,
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
    expect(filterAvailableAgents(["agy", "codex", "missing"]).map((a) => a.type))
      .toEqual(["codex", "agy"]);
  });

  it("hides Cursor from the picker while keeping its registry entry", () => {
    expect(filterAvailableAgents(["cursor-agent", "codex"]).map((a) => a.type)).toEqual(["codex"]);
    expect(getAgentDefinition("cursor")?.label).toBe("Cursor");
  });

  it("caches availability for five minutes", async () => {
    const fetcher = vi.fn(async () => ({ available: ["codex"] }));
    await loadAvailableAgents(fetcher, 1_000);
    await loadAvailableAgents(fetcher, 1_000 + 299_999);
    await loadAvailableAgents(fetcher, 1_000 + 300_001);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).not.toHaveBeenCalledWith(expect.arrayContaining(["copilot"]));
  });

  it("labels the tuning trigger for every model shape", () => {
    const label = (model: ReturnType<typeof getModelDefinition> | null, effort: string | null = null, fast = false) =>
      tuningLabel({ efforts: effortsFor(model), supportsFast: supportsFastFor(model), effort, fast });

    // Terminal: no agent, so no model.
    expect(label(null)).toBe("Effort Default");
    // Agent selected, Model Default.
    expect(label(getModelDefinition("agy", "Gemini 3.1 Pro (High)"))).toBe("Effort Default");
    // Efforts only.
    expect(label(getModelDefinition("claude", "sonnet"), "medium")).toBe("Effort Medium");
    // Both efforts and fast.
    expect(label(getModelDefinition("claude", "opus"), "high", true)).toBe("Effort High · Fast Mode On");
    // Fast only — reachable only if Cursor is un-hidden from the picker.
    const fastOnly = getModelDefinition("cursor", "composer-2.5");
    expect(effortsFor(fastOnly)).toEqual([]);
    expect(supportsFastFor(fastOnly)).toBe(true);
    expect(label(fastOnly)).toBe("Fast Mode Off");
    expect(label(fastOnly, null, true)).toBe("Fast Mode On");
  });

  it("returns no asset for iconless registry types", () => {
    expect(findAgentIconForSurface("cursor", "light")).toBeUndefined();
  });
});
