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
    pendingPhase: null,
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
    complete: true,
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

  it("ignores a pending listener callback after disposal", async () => {
    const registration = deferred<() => void>();
    const pendingGet = deferred<AgentInventorySnapshot | null>();
    let publish: ((event: { payload: AgentInventorySnapshot }) => void) | undefined;
    mocks.get.mockReturnValue(pendingGet.promise);
    mocks.listen.mockImplementation((_event, handler) => {
      publish = handler;
      return registration.promise;
    });
    const { disposeAgentInventory, useAgentInventory } = await import("./useAgentInventory");
    const inventory = useAgentInventory();

    disposeAgentInventory();
    publish?.({ payload: snapshot("2026-07-31T02:00:00.000Z") });

    expect(inventory.snapshot.value).toBeNull();
    expect(inventory.loading.value).toBe(false);
    registration.resolve(mocks.unlisten);
    await flushPromises();
    expect(mocks.unlisten).toHaveBeenCalledTimes(1);
  });

  it("ignores an obsolete pending listener after reinitialization", async () => {
    const firstRegistration = deferred<() => void>();
    const callbacks: Array<(event: { payload: AgentInventorySnapshot }) => void> = [];
    mocks.get.mockResolvedValue(null);
    mocks.listen.mockImplementation((_event, handler) => {
      callbacks.push(handler);
      return callbacks.length === 1 ? firstRegistration.promise : Promise.resolve(mocks.unlisten);
    });
    const { disposeAgentInventory, useAgentInventory } = await import("./useAgentInventory");
    const initial = useAgentInventory();
    disposeAgentInventory();
    const replacement = useAgentInventory();

    callbacks[0]({ payload: snapshot("2026-07-31T01:00:00.000Z") });
    expect(initial.snapshot.value).toBeNull();
    callbacks[1]({ payload: snapshot("2026-07-31T02:00:00.000Z") });

    expect(replacement.snapshot.value?.checkedAt).toBe("2026-07-31T02:00:00.000Z");
    firstRegistration.resolve(mocks.unlisten);
    await flushPromises();
    expect(mocks.unlisten).toHaveBeenCalledTimes(1);
  });

  it("keeps loading until a newer refresh completes when the initial get resolves first", async () => {
    const initialGet = deferred<AgentInventorySnapshot | null>();
    const pendingRefresh = deferred<AgentInventorySnapshot>();
    mocks.get.mockReturnValue(initialGet.promise);
    mocks.refresh.mockReturnValue(pendingRefresh.promise);
    const { useAgentInventory } = await import("./useAgentInventory");
    const inventory = useAgentInventory();
    const refresh = inventory.refresh();

    initialGet.resolve(snapshot("2026-07-31T01:00:00.000Z"));
    await flushPromises();

    expect(inventory.snapshot.value).toBeNull();
    expect(inventory.loading.value).toBe(true);
    pendingRefresh.resolve(snapshot("2026-07-31T02:00:00.000Z"));
    await refresh;

    expect(inventory.snapshot.value?.checkedAt).toBe("2026-07-31T02:00:00.000Z");
    expect(inventory.loading.value).toBe(false);
  });

  it("keeps a newer refresh snapshot when the initial get resolves last", async () => {
    const initialGet = deferred<AgentInventorySnapshot | null>();
    const pendingRefresh = deferred<AgentInventorySnapshot>();
    mocks.get.mockReturnValue(initialGet.promise);
    mocks.refresh.mockReturnValue(pendingRefresh.promise);
    const { useAgentInventory } = await import("./useAgentInventory");
    const inventory = useAgentInventory();
    const refresh = inventory.refresh();

    pendingRefresh.resolve(snapshot("2026-07-31T02:00:00.000Z"));
    await refresh;
    initialGet.resolve(snapshot("2026-07-31T01:00:00.000Z"));
    await flushPromises();

    expect(inventory.snapshot.value?.checkedAt).toBe("2026-07-31T02:00:00.000Z");
    expect(inventory.loading.value).toBe(false);
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
