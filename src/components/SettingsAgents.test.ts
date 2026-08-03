// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computed, createApp, nextTick, ref, type App } from "vue";
import type {
  AgentInventoryItem,
  AgentInventoryKey,
  AgentInventorySnapshot,
  McpAgentStatus,
} from "@/types";

const mocks = vi.hoisted(() => ({
  mcpAgentStatus: vi.fn(),
  mcpInstall: vi.fn(),
  mcpUninstall: vi.fn(),
  mcpManualCommands: vi.fn(),
  openExternal: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  clipboardWrite: vi.fn(),
}));

const useAgentInventory = vi.hoisted(() => vi.fn());

vi.mock("@/composables/useRpc", () => ({
  useRpc: () => ({
    request: {
      mcpAgentStatus: mocks.mcpAgentStatus,
      mcpInstall: mocks.mcpInstall,
      mcpUninstall: mocks.mcpUninstall,
      mcpManualCommands: mocks.mcpManualCommands,
    },
  }),
}));

vi.mock("@/composables/useAgentInventory", () => ({
  useAgentInventory,
}));

vi.mock("@/platform", () => ({
  openExternal: mocks.openExternal,
}));

vi.mock("vue-sonner", () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
  },
}));

import SettingsAgents from "./SettingsAgents.vue";

const inventorySnapshot = ref<AgentInventorySnapshot | null>(null);
const inventoryLoading = ref(false);
const refreshInventory = vi.fn();
const inventory = {
  snapshot: inventorySnapshot,
  loading: inventoryLoading,
  refreshing: computed(() => inventoryLoading.value || inventorySnapshot.value?.complete === false),
  installedKeys: computed(() => new Set(
    inventorySnapshot.value?.agents
      .filter((agent) => agent.discoveryStatus === "installed")
      .map((agent) => agent.key) ?? [],
  )),
  outdatedItems: computed(() =>
    inventorySnapshot.value?.agents.filter((agent) => agent.updateStatus === "outdated") ?? [],
  ),
  refresh: refreshInventory,
};

const KEYS: readonly AgentInventoryKey[] = [
  "claude",
  "codex",
  "antigravity",
  "cursor",
  "grok",
  "opencode",
  "pi",
];

const NAMES: Record<AgentInventoryKey, string> = {
  claude: "Claude",
  codex: "Codex",
  antigravity: "Antigravity",
  cursor: "Cursor",
  grok: "Grok",
  opencode: "OpenCode",
  pi: "Pi",
};

function agent(key: AgentInventoryKey, overrides: Partial<AgentInventoryItem> = {}): AgentInventoryItem {
  return {
    key,
    displayName: NAMES[key],
    discoveryStatus: "installed",
    resolvedBinary: `/Users/verne/.local/bin/${key}`,
    resolvedAlias: key,
    currentVersion: "1.0.0",
    latestVersion: "1.0.0",
    updateStatus: "current",
    updateCommand: `${key} update`,
    updateUrl: null,
    errorCode: null,
    pendingPhase: null,
    ...overrides,
  };
}

function snapshot(agents: AgentInventoryItem[] = [
  agent("claude", {
    currentVersion: "2.1.3",
    latestVersion: "2.1.4",
    updateStatus: "outdated",
    updateCommand: "claude update",
  }),
  agent("codex"),
  agent("antigravity", { latestVersion: null, updateStatus: "unknown" }),
  agent("cursor", {
    discoveryStatus: "missing",
    resolvedBinary: null,
    resolvedAlias: null,
    currentVersion: null,
    latestVersion: "3.0.0",
    updateStatus: "unknown",
  }),
  agent("grok", {
    discoveryStatus: "unknown",
    resolvedBinary: null,
    resolvedAlias: null,
    currentVersion: null,
    latestVersion: null,
    updateStatus: "unknown",
    updateCommand: null,
    errorCode: "discovery",
  }),
  agent("opencode"),
  agent("pi"),
], overrides: Partial<AgentInventorySnapshot> = {}): AgentInventorySnapshot {
  return {
    schemaVersion: 1,
    agents,
    checkedAt: "2026-07-31T10:30:00.000Z",
    expiresAt: "2026-07-31T11:30:00.000Z",
    refreshError: null,
    complete: true,
    ...overrides,
  };
}

function snapshotWithInstalled(...installed: AgentInventoryKey[]): AgentInventorySnapshot {
  const installedKeys = new Set(installed);
  return snapshot(KEYS.map((key) => agent(key, installedKeys.has(key) ? {} : {
    discoveryStatus: "missing",
    resolvedBinary: null,
    resolvedAlias: null,
    currentVersion: null,
    updateStatus: "unknown",
  })));
}

function mcpStatus(key: string, status: McpAgentStatus["status"] = "registered"): McpAgentStatus {
  return { key, displayName: NAMES[key as AgentInventoryKey], status };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
    await nextTick();
  }
}

function row(key: AgentInventoryKey): HTMLElement {
  const match = document.querySelector<HTMLElement>(`[data-agent-key="${key}"]`);
  if (!match) throw new Error(`Missing agent row: ${key}`);
  return match;
}

function find(root: ParentNode, label: string): HTMLElement {
  const match = Array.from(root.querySelectorAll<HTMLElement>("button,[role='menuitem'],[role='switch']"))
    .find((element) => element.textContent?.trim() === label || element.getAttribute("aria-label") === label);
  if (!match) throw new Error(`Missing control: ${label}`);
  return match;
}

function button(root: ParentNode, label: string): HTMLButtonElement {
  return find(root, label) as HTMLButtonElement;
}

/** reka-ui menus want a pointer sequence, not the bare `.click()` jsdom sends. */
async function openMenu(key: AgentInventoryKey): Promise<void> {
  const trigger = find(row(key), "More Actions");
  trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
  await flush();
  if (trigger.getAttribute("data-state") !== "open") {
    trigger.click();
    await flush();
  }
}

async function selectItem(key: AgentInventoryKey, label: string): Promise<void> {
  await openMenu(key);
  const item = find(document, label);
  item.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
  item.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0 }));
  item.click();
  await flush();
}

function versionText(key: AgentInventoryKey): string {
  return Array.from(row(key).querySelectorAll("[data-version-cell] span"))
    .map((element) => element.textContent?.trim() ?? "")
    .join(" ");
}

function skeletons(key: AgentInventoryKey): number {
  return row(key).querySelectorAll("[data-version-cell] [data-slot='skeleton']").length;
}

describe("SettingsAgents", () => {
  let host: HTMLDivElement;
  let app: App<Element>;

  async function mount(value: AgentInventorySnapshot = snapshot()): Promise<void> {
    inventorySnapshot.value = value;
    refreshInventory.mockResolvedValue(value);
    host = document.createElement("div");
    document.body.append(host);
    app = createApp(SettingsAgents);
    app.mount(host);
    await flush();
  }

  beforeEach(() => {
    useAgentInventory.mockReturnValue(inventory);
    inventorySnapshot.value = null;
    inventoryLoading.value = false;
    refreshInventory.mockReset();
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.mcpAgentStatus.mockImplementation(async ({ agent: key }: { agent: string }) => mcpStatus(key));
    mocks.mcpInstall.mockResolvedValue(undefined);
    mocks.mcpUninstall.mockResolvedValue(undefined);
    mocks.mcpManualCommands.mockImplementation(async ({ agent: key }: { agent: string }) => `${key} mcp add verne`);
    mocks.openExternal.mockResolvedValue(undefined);
    mocks.clipboardWrite.mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: mocks.clipboardWrite },
    });
  });

  afterEach(() => {
    app?.unmount();
    host?.remove();
    document.body.replaceChildren();
  });

  it("lists detected agents in registry order with versions, paths, and update state", async () => {
    await mount();

    expect(Array.from(document.querySelectorAll("[data-agent-key]")).map((agentRow) =>
      agentRow.getAttribute("data-agent-key"),
    )).toEqual(["claude", "codex", "antigravity", "opencode", "pi"]);
    expect(versionText("claude")).toBe("2.1.3 2.1.4");
    expect(row("claude").textContent).toContain("Update available");
    expect(row("claude").textContent).toContain("~/.local/bin/claude");
    expect(versionText("codex")).toBe("1.0.0");
    expect(row("codex").textContent).not.toContain("Update available");
    expect(document.body.textContent).toContain("Last Checked");
  });

  it("collects undetected agents into a summarised group", async () => {
    await mount();

    expect(document.body.textContent).toContain("Not Installed (2)");
    expect(document.body.textContent).toContain("Cursor, Grok");
    expect(document.querySelector("[data-agent-key='cursor']")).toBeNull();

    button(document, "Not Installed").click();
    await flush();

    expect(row("cursor").textContent).toContain("Not detected");
    expect(row("grok").textContent).toContain("Detection failed");
  });

  it("shows a skeleton per unresolved version and swaps it for the value", async () => {
    await mount(snapshot([
      agent("claude", { currentVersion: null, latestVersion: null, updateStatus: "unknown", pendingPhase: "version" }),
      agent("codex", { latestVersion: null, updateStatus: "unknown", pendingPhase: "latest" }),
      ...KEYS.slice(2).map((key) => agent(key)),
    ], { complete: false }));

    expect(skeletons("claude")).toBe(1);
    expect(skeletons("codex")).toBe(1);
    expect(versionText("codex")).toContain("1.0.0");
    expect(button(document, "Checking…").disabled).toBe(true);

    inventorySnapshot.value = snapshot();
    await flush();

    expect(skeletons("claude")).toBe(0);
    expect(versionText("claude")).toBe("2.1.3 2.1.4");
    expect(button(document, "Refresh").disabled).toBe(false);
  });

  it("keeps a cached version visible while it re-resolves", async () => {
    await mount(snapshot([
      agent("claude", { currentVersion: "2.1.3", latestVersion: null, updateStatus: "unknown", pendingPhase: "latest" }),
      ...KEYS.slice(1).map((key) => agent(key)),
    ], { complete: false }));

    expect(versionText("claude")).toContain("2.1.3");
    expect(skeletons("claude")).toBe(1);
  });

  it("checks MCP only for installed MCP-capable agents", async () => {
    await mount(snapshotWithInstalled("claude", "pi"));

    expect(mocks.mcpAgentStatus).toHaveBeenCalledTimes(1);
    expect(mocks.mcpAgentStatus).toHaveBeenCalledWith({ agent: "claude" });
  });

  it("does not re-fan MCP probes across progress snapshots of one refresh", async () => {
    await mount(snapshotWithInstalled("claude", "codex"));
    expect(mocks.mcpAgentStatus).toHaveBeenCalledTimes(2);
    mocks.mcpAgentStatus.mockClear();

    const rows = inventorySnapshot.value!.agents;
    inventorySnapshot.value = snapshot(rows.map((item) =>
      item.key === "claude" ? { ...item, pendingPhase: "latest", latestVersion: null } : item,
    ), { complete: false });
    await flush();
    inventorySnapshot.value = snapshot(rows.map((item) =>
      item.key === "claude" ? { ...item, currentVersion: "9.9.9" } : item,
    ));
    await flush();

    expect(mocks.mcpAgentStatus).not.toHaveBeenCalled();
  });

  it("re-fans MCP probes when the installed MCP-capable set changes", async () => {
    await mount(snapshotWithInstalled("claude"));
    mocks.mcpAgentStatus.mockClear();

    inventorySnapshot.value = snapshotWithInstalled("claude", "codex");
    await flush();

    expect(mocks.mcpAgentStatus.mock.calls.map(([argument]) => argument.agent)).toEqual(["claude", "codex"]);
  });

  it("shows a placeholder until MCP status arrives, then reflects it in the switch", async () => {
    const pending = deferred<McpAgentStatus>();
    mocks.mcpAgentStatus.mockReset();
    mocks.mcpAgentStatus.mockImplementation(() => pending.promise);
    await mount(snapshotWithInstalled("claude"));

    expect(row("claude").querySelector("[data-mcp-controls] [role='switch']")).toBeNull();

    pending.resolve(mcpStatus("claude", "registered"));
    await flush();

    expect(find(row("claude"), "Verne MCP").getAttribute("aria-checked")).toBe("true");
  });

  it("installs and removes Verne MCP from the switch", async () => {
    mocks.mcpAgentStatus.mockImplementation(async ({ agent: key }: { agent: string }) =>
      mcpStatus(key, key === "codex" ? "detected" : "registered"),
    );
    await mount();

    expect(find(row("codex"), "Verne MCP").getAttribute("aria-checked")).toBe("false");
    find(row("codex"), "Verne MCP").click();
    find(row("claude"), "Verne MCP").click();
    await flush();

    expect(mocks.mcpInstall).toHaveBeenCalledWith({ agent: "codex" });
    expect(mocks.mcpUninstall).toHaveBeenCalledWith({ agent: "claude" });
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Installed Verne MCP");
  });

  it("treats a needs-approval registration as on and says so", async () => {
    mocks.mcpAgentStatus.mockImplementation(async ({ agent: key }: { agent: string }) =>
      mcpStatus(key, "needsApproval"),
    );
    await mount(snapshotWithInstalled("codex"));

    expect(find(row("codex"), "Verne MCP").getAttribute("aria-checked")).toBe("true");
    expect(row("codex").textContent).toContain("Approve Verne MCP in the agent");
  });

  it("offers update, guide, and path actions from the overflow menu", async () => {
    const value = snapshot();
    value.agents = value.agents.map((item) => item.key === "codex" ? {
      ...item,
      updateCommand: null,
      updateUrl: "https://developers.openai.com/codex/cli/",
    } : item);
    await mount(value);

    await selectItem("claude", "Copy Update Command");
    expect(mocks.clipboardWrite).toHaveBeenCalledWith("claude update");

    await selectItem("codex", "View Installation Guide");
    expect(mocks.openExternal).toHaveBeenCalledWith("https://developers.openai.com/codex/cli/");

    await selectItem("claude", "Copy Path");
    expect(mocks.clipboardWrite).toHaveBeenCalledWith("/Users/verne/.local/bin/claude");
  });

  it("expands manual setup and copies its commands", async () => {
    await mount();

    await selectItem("opencode", "Manual Setup");
    expect(row("opencode").textContent).toContain("opencode mcp add verne");

    button(row("opencode"), "Copy Install Commands").click();
    await flush();

    expect(mocks.mcpManualCommands).toHaveBeenCalledWith({ agent: "opencode" });
    expect(mocks.clipboardWrite).toHaveBeenCalledWith("opencode mcp add verne");
  });

  it("reports version, latest, and MCP check failures without red alarm", async () => {
    mocks.mcpAgentStatus.mockImplementation(async ({ agent: key }: { agent: string }) => {
      if (key === "claude") throw new Error("MCP probe unavailable");
      return mcpStatus(key);
    });
    const value = snapshot();
    value.agents = value.agents.map((item) => {
      if (item.key === "antigravity") return { ...item, errorCode: "version" as const };
      if (item.key === "pi") {
        return { ...item, latestVersion: null, updateStatus: "unknown" as const, errorCode: "latest" as const };
      }
      return item;
    });
    await mount(value);

    expect(row("antigravity").textContent).toContain("Version check failed");
    expect(row("pi").textContent).toContain("Latest check failed");
    expect(row("claude").textContent).toContain("MCP check failed");
    expect(document.querySelector(".text-destructive")).toBeNull();
  });

  it("refreshes inventory once then checks every installed MCP-capable agent", async () => {
    const value = snapshotWithInstalled("claude", "codex", "cursor", "opencode", "pi");
    await mount(value);
    refreshInventory.mockClear();
    mocks.mcpAgentStatus.mockClear();

    button(document, "Refresh").click();
    await flush();

    expect(refreshInventory).toHaveBeenCalledTimes(1);
    expect(mocks.mcpAgentStatus.mock.calls.map(([argument]) => argument.agent)).toEqual([
      "claude", "codex", "cursor", "opencode",
    ]);
  });

  it("keeps a row busy until overlapping checks settle and lets the newest result win", async () => {
    await mount(snapshotWithInstalled("claude"));
    const older = deferred<McpAgentStatus>();
    const newer = deferred<McpAgentStatus>();
    mocks.mcpAgentStatus.mockReset();
    mocks.mcpAgentStatus
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise);

    await selectItem("claude", "Check MCP Status");
    inventorySnapshot.value = snapshotWithInstalled("claude", "opencode");
    await flush();

    expect(mocks.mcpAgentStatus).toHaveBeenCalledTimes(3);
    expect(row("claude").querySelector("[role='switch']")).toBeNull();

    older.resolve(mcpStatus("claude", "detected"));
    await flush();
    newer.resolve(mcpStatus("claude", "needsApproval"));
    await flush();

    expect(find(row("claude"), "Verne MCP").getAttribute("aria-checked")).toBe("true");
    expect(row("claude").textContent).toContain("Approve Verne MCP in the agent");
  });

  it("reconciles an install after a pushed refresh returns the pre-install state", async () => {
    mocks.mcpAgentStatus.mockImplementation(async ({ agent: key }: { agent: string }) =>
      mcpStatus(key, "detected"),
    );
    await mount(snapshotWithInstalled("codex"));
    const install = deferred<void>();
    const bulk = deferred<McpAgentStatus>();
    const postInstall = deferred<McpAgentStatus>();
    mocks.mcpInstall.mockImplementationOnce(() => install.promise);
    mocks.mcpAgentStatus.mockReset();
    let codexCalls = 0;
    mocks.mcpAgentStatus.mockImplementation(({ agent: key }: { agent: string }) => {
      if (key !== "codex") return Promise.resolve(mcpStatus(key, "detected"));
      codexCalls += 1;
      return codexCalls === 1 ? bulk.promise : postInstall.promise;
    });
    refreshInventory.mockClear();

    find(row("codex"), "Verne MCP").click();
    await flush();
    expect(button(document, "Refresh").disabled).toBe(true);
    button(document, "Refresh").click();
    expect(refreshInventory).not.toHaveBeenCalled();

    inventorySnapshot.value = snapshotWithInstalled("codex", "opencode");
    await flush();
    bulk.resolve(mcpStatus("codex", "detected"));
    await flush();

    install.resolve();
    await flush();
    postInstall.resolve(mcpStatus("codex", "registered"));
    await flush();

    expect(find(row("codex"), "Verne MCP").getAttribute("aria-checked")).toBe("true");
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Installed Verne MCP");
  });

  it("does not commit, recheck, or toast after unmounting direct MCP operations", async () => {
    const initial: Record<string, McpAgentStatus["status"]> = {
      claude: "registered",
      codex: "detected",
      opencode: "registered",
    };
    mocks.mcpAgentStatus.mockImplementation(async ({ agent: key }: { agent: string }) =>
      mcpStatus(key, initial[key]),
    );
    await mount(snapshotWithInstalled("claude", "codex", "opencode"));
    const install = deferred<void>();
    const remove = deferred<void>();
    const check = deferred<McpAgentStatus>();
    mocks.mcpInstall.mockImplementationOnce(() => install.promise);
    mocks.mcpUninstall.mockImplementationOnce(() => remove.promise);
    mocks.mcpAgentStatus.mockReset();
    mocks.mcpAgentStatus.mockImplementationOnce(() => check.promise);

    find(row("codex"), "Verne MCP").click();
    find(row("claude"), "Verne MCP").click();
    await selectItem("opencode", "Check MCP Status");
    app.unmount();

    install.resolve();
    remove.reject(new Error("late remove failure"));
    check.reject(new Error("late check failure"));
    await flush();

    expect(mocks.mcpAgentStatus).toHaveBeenCalledTimes(1);
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("does not commit or toast from manual and clipboard continuations after unmount", async () => {
    await mount();
    const manual = deferred<string>();
    const clipboard = deferred<void>();
    mocks.mcpManualCommands.mockReset();
    mocks.mcpManualCommands.mockImplementationOnce(() => manual.promise);
    mocks.clipboardWrite.mockReset();
    mocks.clipboardWrite.mockImplementationOnce(() => clipboard.promise);

    await selectItem("opencode", "Manual Setup");
    await selectItem("claude", "Copy Update Command");
    app.unmount();

    manual.reject(new Error("late manual failure"));
    clipboard.resolve();
    await flush();

    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("does not toast when inventory refresh rejects after unmount", async () => {
    await mount();
    const refresh = deferred<AgentInventorySnapshot>();
    refreshInventory.mockReset();
    refreshInventory.mockImplementationOnce(() => refresh.promise);

    button(document, "Refresh").click();
    await flush();
    app.unmount();
    refresh.reject(new Error("late inventory failure"));
    await flush();

    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("notes that a discovery failure may leave stale rows", async () => {
    const value = snapshot();
    value.refreshError = "discovery";
    await mount(value);

    expect(document.body.textContent).toContain("Detection failed");
    expect(document.body.textContent).toContain("prior results may be stale");
  });
});
