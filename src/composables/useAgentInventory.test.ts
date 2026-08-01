import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentInventoryItem, AgentInventorySnapshot } from "@/types";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  refresh: vi.fn(),
  listen: vi.fn(),
  unlisten: vi.fn(),
}));

vi.mock("@/composables/useRpc", () => ({
  useRpc: () => ({
    request: {
      agentInventoryGet: mocks.get,
      agentInventoryRefresh: mocks.refresh,
    },
  }),
}));

vi.mock("@/platform", () => ({
  listen: mocks.listen,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function agent(overrides: Partial<AgentInventoryItem> = {}): AgentInventoryItem {
  return {
    key: "claude",
    displayName: "Claude",
    discoveryStatus: "installed",
    resolvedBinary: "/usr/local/bin/claude",
    resolvedAlias: null,
    currentVersion: "2.1.3",
    latestVersion: "2.1.4",
    updateStatus: "outdated",
    updateCommand: "claude update",
    updateUrl: null,
    errorCode: null,
    ...overrides,
  };
}

function snapshot(checkedAt: string, agents: AgentInventoryItem[] = [agent()]): AgentInventorySnapshot {
  return {
    schemaVersion: 1,
    agents,
    checkedAt,
    expiresAt: "2026-08-01T00:00:00.000Z",
    refreshError: null,
  };
}

describe("useAgentInventory", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.listen.mockImplementation(async (_event, _handler) => mocks.unlisten);
    mocks.get.mockResolvedValue(null);
    mocks.refresh.mockResolvedValue(snapshot("2026-07-31T00:00:00.000Z"));
  });

  afterEach(async () => {
    const { disposeAgentInventory } = await import("./useAgentInventory");
    disposeAgentInventory();
  });

  it("ignores an initial get that resolves after a pushed snapshot", async () => {
    const pending = deferred<AgentInventorySnapshot | null>();
    const newerSnapshot = snapshot("2026-07-31T02:00:00.000Z");
    const olderSnapshot = snapshot("2026-07-31T01:00:00.000Z");
    mocks.get.mockReturnValue(pending.promise);
    let publish: ((event: { payload: AgentInventorySnapshot }) => void) | undefined;
    mocks.listen.mockImplementation(async (_event, handler) => {
      publish = handler;
      return mocks.unlisten;
    });

    const { useAgentInventory } = await import("./useAgentInventory");
    const inventory = useAgentInventory();
    await flushPromises();
    publish?.({ payload: newerSnapshot });
    pending.resolve(olderSnapshot);
    await flushPromises();

    expect(inventory.snapshot.value).toEqual(newerSnapshot);
  });

  it("registers one listener across multiple consumers", async () => {
    const { useAgentInventory } = await import("./useAgentInventory");

    useAgentInventory();
    useAgentInventory();
    await flushPromises();

    expect(mocks.listen).toHaveBeenCalledTimes(1);
  });

  it("unlistens and clears module state when disposed", async () => {
    const first = snapshot("2026-07-31T01:00:00.000Z");
    const second = snapshot("2026-07-31T02:00:00.000Z");
    mocks.get.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const { disposeAgentInventory, useAgentInventory } = await import("./useAgentInventory");

    const initial = useAgentInventory();
    await flushPromises();
    disposeAgentInventory();
    expect(initial.snapshot.value).toBeNull();
    const replacement = useAgentInventory();
    await flushPromises();

    expect(mocks.unlisten).toHaveBeenCalledTimes(1);
    expect(mocks.listen).toHaveBeenCalledTimes(2);
    expect(replacement.snapshot.value).toEqual(second);
  });

  it("derives installed keys and outdated items from the latest snapshot", async () => {
    mocks.get.mockResolvedValue(snapshot("2026-07-31T01:00:00.000Z", [
      agent({ key: "claude", discoveryStatus: "installed", updateStatus: "outdated" }),
      agent({ key: "codex", discoveryStatus: "missing", updateStatus: "current" }),
    ]));
    const { useAgentInventory } = await import("./useAgentInventory");
    const inventory = useAgentInventory();
    await flushPromises();

    expect(inventory.installedKeys.value).toEqual(new Set(["claude"]));
    expect(inventory.outdatedItems.value.map((item) => item.key)).toEqual(["claude"]);
  });
});
