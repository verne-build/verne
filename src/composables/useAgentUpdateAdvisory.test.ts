import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import type { AgentDiscoveryStatus, AgentInventoryItem, AgentInventoryKey, AgentInventorySnapshot, AgentUpdateStatus } from "@/types";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  refresh: vi.fn(),
  listen: vi.fn(),
  unlisten: vi.fn(),
  toast: vi.fn(),
  activeCategory: { value: "appearance" },
  showSettings: { value: false },
}));

let publishInventory: ((event: { payload: AgentInventorySnapshot }) => void) | undefined;
const NOW = Date.parse("2026-07-31T01:30:00.000Z");

vi.mock("@/composables/useRpc", () => ({
  useRpc: () => ({ request: { agentInventoryGet: mocks.get, agentInventoryRefresh: mocks.refresh } }),
}));
vi.mock("@/platform", () => ({ listen: mocks.listen }));
vi.mock("vue-sonner", () => ({ toast: mocks.toast }));
vi.mock("@/composables/useSettingsNav", () => ({
  useSettingsNav: () => ({ activeCategory: mocks.activeCategory }),
}));
vi.mock("@/composables/useSettingsScreen", () => ({
  useSettingsScreen: () => ({ showSettings: mocks.showSettings }),
}));

function item(
  key: AgentInventoryKey,
  displayName: string,
  discoveryStatus: AgentDiscoveryStatus = "installed",
  updateStatus: AgentUpdateStatus = "outdated",
  latestVersion: string | null = "2.1.4",
): AgentInventoryItem {
  return {
    key,
    displayName,
    discoveryStatus,
    resolvedBinary: discoveryStatus === "installed" ? `/usr/local/bin/${key}` : null,
    resolvedAlias: null,
    currentVersion: "2.1.3",
    latestVersion,
    updateStatus,
    updateCommand: null,
    updateUrl: null,
    errorCode: null,
    pendingPhase: null,
  };
}

function snapshot(
  agents: AgentInventoryItem[],
  overrides: Partial<Pick<AgentInventorySnapshot, "expiresAt" | "refreshError">> = {},
): AgentInventorySnapshot {
  return {
    schemaVersion: 1,
    agents,
    checkedAt: "2026-07-31T01:00:00.000Z",
    expiresAt: "2026-07-31T02:00:00.000Z",
    refreshError: null,
    complete: true,
    ...overrides,
  };
}

describe("useAgentUpdateAdvisory", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.activeCategory.value = "appearance";
    mocks.showSettings.value = false;
    mocks.get.mockResolvedValue(null);
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    publishInventory = undefined;
    mocks.listen.mockImplementation(async (_event, handler) => {
      publishInventory = handler;
      return mocks.unlisten;
    });
  });

  afterEach(async () => {
    const { disposeAgentInventory } = await import("./useAgentInventory");
    disposeAgentInventory();
    vi.restoreAllMocks();
  });

  async function start() {
    const { useAgentInventory } = await import("./useAgentInventory");
    const { useAgentUpdateAdvisory } = await import("./useAgentUpdateAdvisory");
    const inventory = useAgentInventory();
    useAgentUpdateAdvisory();
    return inventory;
  }

  async function publish(value: AgentInventorySnapshot): Promise<void> {
    publishInventory?.({ payload: value });
    await nextTick();
  }

  it("shows one toast for three outdated agents", async () => {
    await start();
    await publish(snapshot([
      item("claude", "Claude"), item("codex", "Codex"), item("pi", "Pi"),
    ]));

    expect(mocks.toast).toHaveBeenCalledTimes(1);
    expect(mocks.toast).toHaveBeenCalledWith("Agent Updates Available", expect.objectContaining({
      description: "Updates are available for 3 agents.",
      id: "agent-update-advisory",
    }));
  });

  it.each([
    [["Claude"], "Claude has an update available."],
    [["Claude", "Codex"], "Claude and Codex have updates available."],
  ])("formats advisory names", async (names, description) => {
    await start();
    const keys: AgentInventoryKey[] = ["claude", "codex"];
    await publish(snapshot(names.map((name, index) => item(keys[index], name))));

    expect(mocks.toast).toHaveBeenLastCalledWith("Agent Updates Available", expect.objectContaining({ description }));
  });

  it.each(["current", "missing", "unknown"] as const)("stays silent for %s", async (state) => {
    await start();
    const row = state === "missing"
      ? item("claude", "Claude", "missing", "unknown", null)
      : item("claude", "Claude", "installed", state, state === "unknown" ? null : "2.1.4");
    await publish(snapshot([row]));

    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("deduplicates one version and notifies for the next", async () => {
    await start();
    await publish(snapshot([item("claude", "Claude", "installed", "outdated", "2.1.4")]));
    await publish(snapshot([item("claude", "Claude", "installed", "outdated", "2.1.4")]));
    await publish(snapshot([item("claude", "Claude", "installed", "outdated", "2.1.5")]));

    expect(mocks.toast).toHaveBeenCalledTimes(2);
  });

  it("stays silent for an expired snapshot", async () => {
    await start();
    await publish(snapshot(
      [item("claude", "Claude")],
      { expiresAt: new Date(NOW).toISOString() },
    ));

    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("stays silent for retained outdated rows after discovery failure", async () => {
    await start();
    await publish(snapshot(
      [item("claude", "Claude")],
      { refreshError: "discovery" },
    ));

    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("notifies immediately from a fresh error-free cached snapshot and deduplicates its push", async () => {
    const cached = snapshot([item("claude", "Claude")]);
    mocks.get.mockResolvedValue(cached);

    await start();
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledTimes(1));
    await publish(cached);

    expect(mocks.toast).toHaveBeenCalledTimes(1);
  });

  it("opens MCP settings from the toast action", async () => {
    await start();
    await publish(snapshot([item("claude", "Claude")]));
    const options = mocks.toast.mock.calls[0][1] as { action: { onClick: () => void } };

    options.action.onClick();

    expect(mocks.activeCategory.value).toBe("mcp");
    expect(mocks.showSettings.value).toBe(true);
  });
});
