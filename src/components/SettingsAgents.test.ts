// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computed, createApp, nextTick, ref, type App } from "vue";
import type { AgentInventoryItem, AgentInventoryKey, AgentInventorySnapshot, McpAgentStatus } from "@/types";

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
]): AgentInventorySnapshot {
  return {
    schemaVersion: 1,
    agents,
    checkedAt: "2026-07-31T10:30:00.000Z",
    expiresAt: "2026-07-31T11:30:00.000Z",
    refreshError: null,
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

function button(root: ParentNode, label: string): HTMLButtonElement {
  const match = Array.from(root.querySelectorAll<HTMLButtonElement>("button"))
    .find((element) => element.textContent?.trim() === label || element.getAttribute("aria-label") === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
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

  it("renders seven inventory rows in registry order with status, versions, guidance, and shortened paths", async () => {
    await mount();

    expect(Array.from(document.querySelectorAll("[data-agent-key]")).map((agentRow) =>
      agentRow.getAttribute("data-agent-key"),
    )).toEqual(KEYS);
    expect(row("claude").textContent).toContain("Detected");
    expect(row("claude").textContent).toContain("2.1.3");
    expect(row("claude").textContent).toContain("2.1.4");
    expect(row("claude").textContent).toContain("Update Available");
    expect(row("claude").textContent).toContain("~/.local/bin/claude");
    expect(row("codex").textContent).toContain("Current");
    expect(row("cursor").textContent).toContain("Not Detected");
    expect(row("grok").textContent).toContain("Check Failed");
    expect(document.body.textContent).toContain("Last Checked");
    expect(row("claude").querySelector("[data-mcp-controls]")).toBeTruthy();
    expect(row("antigravity").querySelector("[data-mcp-controls]")).toBeFalsy();
    expect(row("grok").querySelector("[data-mcp-controls]")).toBeFalsy();
    expect(row("pi").querySelector("[data-mcp-controls]")).toBeFalsy();
    expect(button(row("cursor"), "Install MCP").disabled).toBe(true);
  });

  it("checks MCP only for installed MCP-capable agents", async () => {
    await mount(snapshotWithInstalled("claude", "pi"));

    expect(mocks.mcpAgentStatus).toHaveBeenCalledTimes(1);
    expect(mocks.mcpAgentStatus).toHaveBeenCalledWith({ agent: "claude" });
  });

  it("copies update commands and opens static installation guides", async () => {
    const value = snapshot();
    value.agents = value.agents.map((item) => item.key === "codex" ? {
      ...item,
      updateCommand: null,
      updateUrl: "https://developers.openai.com/codex/cli/",
    } : item);
    await mount(value);

    button(row("claude"), "Copy Update Command").click();
    button(row("codex"), "View Installation Guide").click();
    await flush();

    expect(mocks.clipboardWrite).toHaveBeenCalledWith("claude update");
    expect(mocks.openExternal).toHaveBeenCalledWith("https://developers.openai.com/codex/cli/");
  });

  it("refreshes inventory once then checks every installed MCP-capable agent", async () => {
    const value = snapshotWithInstalled("claude", "codex", "cursor", "opencode", "pi");
    await mount(value);
    refreshInventory.mockClear();
    mocks.mcpAgentStatus.mockClear();

    button(document, "Refresh").click();
    await flush();

    expect(refreshInventory).toHaveBeenCalledTimes(1);
    expect(mocks.mcpAgentStatus).toHaveBeenCalledTimes(4);
    expect(mocks.mcpAgentStatus.mock.calls.map(([argument]) => argument.agent)).toEqual([
      "claude", "codex", "cursor", "opencode",
    ]);
  });

  it("keeps MCP failures independent from inventory state", async () => {
    mocks.mcpAgentStatus.mockImplementation(async ({ agent: key }: { agent: string }) => {
      if (key === "claude") throw new Error("MCP probe unavailable");
      return mcpStatus(key);
    });
    await mount();

    expect(row("claude").textContent).toContain("Detected");
    expect(row("claude").textContent).toContain("Update Available");
    expect(row("claude").textContent).toContain("MCP Check Failed");
    expect(row("claude").textContent).toContain("MCP probe unavailable");
  });

  it("retains install, remove, manual expansion, and manual copy flows", async () => {
    mocks.mcpAgentStatus.mockImplementation(async ({ agent: key }: { agent: string }) =>
      mcpStatus(key, key === "codex" ? "detected" : "registered"),
    );
    await mount();

    button(row("codex"), "Install MCP").click();
    button(row("claude"), "Remove MCP").click();
    button(row("opencode"), "Show Manual Setup").click();
    await flush();
    button(row("opencode"), "Copy Install Commands").click();
    await flush();

    expect(mocks.mcpInstall).toHaveBeenCalledWith({ agent: "codex" });
    expect(mocks.mcpUninstall).toHaveBeenCalledWith({ agent: "claude" });
    expect(mocks.mcpManualCommands).toHaveBeenCalledWith({ agent: "opencode" });
    expect(mocks.clipboardWrite).toHaveBeenCalledWith("opencode mcp add verne");
  });

  it("retains the exact Check MCP Status action beside every known MCP state", async () => {
    const statuses: Record<string, McpAgentStatus["status"]> = {
      claude: "registered",
      codex: "needsApproval",
      cursor: "detected",
      opencode: "notDetected",
    };
    mocks.mcpAgentStatus.mockImplementation(async ({ agent: key }: { agent: string }) =>
      mcpStatus(key, statuses[key]),
    );
    await mount(snapshotWithInstalled("claude", "codex", "cursor", "opencode"));

    for (const key of ["claude", "codex", "cursor", "opencode"] as const) {
      expect(button(row(key), "Check MCP Status")).toBeTruthy();
    }
    expect(button(row("claude"), "Remove MCP")).toBeTruthy();
    expect(button(row("codex"), "Remove MCP")).toBeTruthy();
    expect(button(row("cursor"), "Install MCP")).toBeTruthy();
    expect(button(row("opencode"), "Install MCP")).toBeTruthy();
  });

  it("keeps a row busy until overlapping checks settle and lets the newest result win", async () => {
    await mount(snapshotWithInstalled("claude"));
    const older = deferred<McpAgentStatus>();
    const newer = deferred<McpAgentStatus>();
    mocks.mcpAgentStatus.mockReset();
    mocks.mcpAgentStatus
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise);

    button(row("claude"), "Check MCP Status").click();
    await flush();
    inventorySnapshot.value = snapshotWithInstalled("claude");
    await flush();

    expect(mocks.mcpAgentStatus).toHaveBeenCalledTimes(2);
    expect(button(row("claude"), "Check MCP Status").disabled).toBe(true);

    older.resolve(mcpStatus("claude", "detected"));
    await flush();

    expect(row("claude").textContent).not.toContain("MCP Not Installed");
    expect(button(row("claude"), "Check MCP Status").disabled).toBe(true);

    newer.resolve(mcpStatus("claude", "needsApproval"));
    await flush();

    expect(row("claude").textContent).toContain("MCP Needs Approval");
    expect(button(row("claude"), "Check MCP Status").disabled).toBe(false);
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
    mocks.mcpAgentStatus
      .mockImplementationOnce(() => bulk.promise)
      .mockImplementationOnce(() => postInstall.promise);
    refreshInventory.mockClear();

    button(row("codex"), "Install MCP").click();
    await flush();
    expect(button(document, "Refresh").disabled).toBe(true);
    button(document, "Refresh").click();
    expect(refreshInventory).not.toHaveBeenCalled();

    inventorySnapshot.value = snapshotWithInstalled("codex");
    await flush();
    bulk.resolve(mcpStatus("codex", "detected"));
    await flush();

    expect(button(row("codex"), "Check MCP Status").disabled).toBe(true);
    expect(button(row("codex"), "Install MCP").disabled).toBe(true);

    install.resolve();
    await flush();
    expect(mocks.mcpAgentStatus).toHaveBeenCalledTimes(2);
    expect(button(row("codex"), "Check MCP Status").disabled).toBe(true);

    postInstall.resolve(mcpStatus("codex", "registered"));
    await flush();

    expect(row("codex").textContent).toContain("MCP Installed");
    expect(button(row("codex"), "Check MCP Status").disabled).toBe(false);
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Installed Verne MCP");
  });

  it("reconciles a remove after a pushed refresh returns the pre-remove state", async () => {
    mocks.mcpAgentStatus.mockImplementation(async ({ agent: key }: { agent: string }) =>
      mcpStatus(key, "registered"),
    );
    await mount(snapshotWithInstalled("claude"));
    const remove = deferred<void>();
    const bulk = deferred<McpAgentStatus>();
    const postRemove = deferred<McpAgentStatus>();
    mocks.mcpUninstall.mockImplementationOnce(() => remove.promise);
    mocks.mcpAgentStatus.mockReset();
    mocks.mcpAgentStatus
      .mockImplementationOnce(() => bulk.promise)
      .mockImplementationOnce(() => postRemove.promise);

    button(row("claude"), "Remove MCP").click();
    await flush();
    inventorySnapshot.value = snapshotWithInstalled("claude");
    await flush();
    bulk.resolve(mcpStatus("claude", "registered"));
    await flush();

    expect(button(row("claude"), "Check MCP Status").disabled).toBe(true);
    expect(button(row("claude"), "Remove MCP").disabled).toBe(true);

    remove.resolve();
    await flush();
    expect(mocks.mcpAgentStatus).toHaveBeenCalledTimes(2);
    expect(button(row("claude"), "Check MCP Status").disabled).toBe(true);

    postRemove.resolve(mcpStatus("claude", "detected"));
    await flush();

    expect(row("claude").textContent).toContain("MCP Not Installed");
    expect(button(row("claude"), "Install MCP")).toBeTruthy();
    expect(button(row("claude"), "Check MCP Status").disabled).toBe(false);
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

    button(row("codex"), "Install MCP").click();
    button(row("claude"), "Remove MCP").click();
    button(row("opencode"), "Check MCP Status").click();
    await flush();
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

    button(row("opencode"), "Show Manual Setup").click();
    button(row("claude"), "Copy Update Command").click();
    await flush();
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

  it("labels version and latest lookup failures without flattening discovery failures", async () => {
    const value = snapshot();
    value.agents = value.agents.map((item) => {
      if (item.key === "antigravity") return { ...item, errorCode: "version" };
      if (item.key === "pi") return { ...item, latestVersion: null, updateStatus: "unknown", errorCode: "latest" };
      return item;
    });
    await mount(value);

    expect(row("antigravity").textContent).toContain("Version Check Failed");
    expect(row("pi").textContent).toContain("Latest Check Failed");
    expect(row("grok").textContent).toContain("Check Failed");
  });

  it("states that a snapshot discovery failure may retain stale prior results", async () => {
    const value = snapshot();
    value.refreshError = "discovery";
    await mount(value);

    expect(document.body.textContent).toContain("Detection Failed");
    expect(document.body.textContent).toContain("Prior results may be stale or retained");
    expect(document.body.textContent).not.toContain("Latest-version checks may be unavailable");
  });
});
