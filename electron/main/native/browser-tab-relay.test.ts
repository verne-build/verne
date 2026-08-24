// @vitest-environment node
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  handlers: new Map<string, (params: any, win?: any, event?: any) => unknown>(),
}));

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: class {},
}));
vi.mock("../ipc-router", () => ({
  registerNative: vi.fn((method: string, handler: (params: any, win?: any, event?: any) => unknown) => {
    native.handlers.set(method, handler);
  }),
}));

import { BrowserTabRelay } from "./browser-tab-relay";

const request = {
  newTabId: "browser:explicit",
  url: "https://example.com",
  workspaceDir: "/worktrees/feature",
  scopeType: "directory" as const,
  scopeId: "worktree-1",
  source: "mcp" as const,
  allowReuse: true,
};

function fakeWindow(id: number) {
  const webContents = Object.assign(new EventEmitter(), {
    id,
    isDestroyed: () => false,
    send: vi.fn(),
  });
  return Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    webContents,
  }) as any;
}

function sent(win: ReturnType<typeof fakeWindow>, name: string) {
  return win.webContents.send.mock.calls
    .filter((call: unknown[]) => call[1] === name)
    .map((call: unknown[]) => call[2]);
}

afterEach(() => {
  vi.useRealTimers();
  native.handlers.clear();
});

describe("BrowserTabRelay", () => {
  it("queues startup requests until the current renderer generation reports ready", async () => {
    const win = fakeWindow(11);
    const relay = new BrowserTabRelay({ waitForUi: vi.fn() } as any, () => win, {
      timeoutMs: 100, createId: () => "request-1",
    });
    relay.attachWindow(win);
    relay.installIpc();

    const opening = relay.open(request);
    expect(win.webContents.send).not.toHaveBeenCalled();

    expect(native.handlers.get("native_browser_relay_ready")?.(
      {}, win, { sender: { id: 11 } },
    )).toBe(1);
    expect(sent(win, "browser-tab-open-request")).toEqual([{
      requestId: "request-1",
      generation: 1,
      ...request,
    }]);

    const ack = {
      requestId: "request-1",
      generation: 1,
      workspaceDir: request.workspaceDir,
      scopeType: request.scopeType,
      scopeId: request.scopeId,
      ok: true,
      tabId: request.newTabId,
      reused: false,
      created: true,
    };
    relay.acknowledge(ack);
    await expect(opening).resolves.toEqual({
      tabId: request.newTabId, reused: false, created: true,
    });
  });

  it("waits for registration owned by the current window before resolving", async () => {
    const win = fakeWindow(12);
    let ready!: (value: unknown) => void;
    const registration = new Promise((resolve) => { ready = resolve; });
    const waitForUi = vi.fn(() => registration);
    const relay = new BrowserTabRelay({ waitForUi } as any, () => win, {
      timeoutMs: 100, createId: () => "request-2",
    });
    relay.attachWindow(win);
    relay.markRendererReady(win);

    const opening = relay.open(request);
    relay.acknowledge({
      requestId: "request-2", generation: 1,
      workspaceDir: request.workspaceDir, scopeType: request.scopeType, scopeId: request.scopeId,
      ok: true, tabId: request.newTabId, reused: false, created: true,
    });
    expect(waitForUi).toHaveBeenCalledWith(
      request.newTabId,
      request.workspaceDir,
      100,
      expect.objectContaining({ hostWebContentsId: 12, signal: expect.any(AbortSignal) }),
    );
    let settled = false;
    void opening.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    ready({ tabId: request.newTabId });
    await expect(opening).resolves.toEqual({
      tabId: request.newTabId, reused: false, created: true,
    });
  });

  it("resends one idempotent request after renderer reload and rejects the stale acknowledgement", async () => {
    const win = fakeWindow(13);
    const relay = new BrowserTabRelay({ waitForUi: vi.fn(async () => ({})) } as any, () => win, {
      timeoutMs: 100, createId: () => "request-reload",
    });
    relay.attachWindow(win);
    relay.markRendererReady(win);
    const opening = relay.open(request);

    win.webContents.emit("did-start-navigation", {}, "app://reload", false, true);
    expect(relay.markRendererReady(win)).toBe(2);
    expect(sent(win, "browser-tab-open-request").map(
      (payload: { generation: number }) => payload.generation,
    )).toEqual([1, 2]);

    expect(relay.acknowledge({
      requestId: "request-reload", generation: 1,
      workspaceDir: request.workspaceDir, scopeType: request.scopeType, scopeId: request.scopeId,
      ok: true, tabId: request.newTabId, reused: false, created: true,
    })).toBe(false);
    expect(relay.acknowledge({
      requestId: "request-reload", generation: 2,
      workspaceDir: request.workspaceDir, scopeType: request.scopeType, scopeId: request.scopeId,
      ok: true, tabId: request.newTabId, reused: false, created: true,
    })).toBe(true);

    await expect(opening).resolves.toEqual({
      tabId: request.newTabId, reused: false, created: true,
    });
  });

  it("moves an in-flight request to a recreated window and waits for its readiness", async () => {
    const oldWindow = fakeWindow(14);
    const newWindow = fakeWindow(15);
    let current = oldWindow;
    const relay = new BrowserTabRelay({ waitForUi: vi.fn(async () => ({})) } as any, () => current, {
      timeoutMs: 100, createId: () => "request-window",
    });
    relay.attachWindow(oldWindow);
    relay.markRendererReady(oldWindow);
    const opening = relay.open(request);

    current = newWindow;
    relay.attachWindow(newWindow);
    expect(newWindow.webContents.send).not.toHaveBeenCalled();
    expect(relay.markRendererReady(newWindow)).toBe(2);
    expect(sent(newWindow, "browser-tab-open-request")).toEqual([
      expect.objectContaining({ requestId: "request-window", generation: 2 }),
    ]);
    relay.acknowledge({
      requestId: "request-window", generation: 2,
      workspaceDir: request.workspaceDir, scopeType: request.scopeType, scopeId: request.scopeId,
      ok: true, tabId: request.newTabId, reused: false, created: true,
    });

    await expect(opening).resolves.toEqual({
      tabId: request.newTabId, reused: false, created: true,
    });
  });

  it("ignores a readiness handshake sent by an obsolete renderer webContents", async () => {
    const oldWindow = fakeWindow(19);
    const newWindow = fakeWindow(20);
    const relay = new BrowserTabRelay({ waitForUi: vi.fn(async () => ({})) } as any, () => newWindow, {
      timeoutMs: 100, createId: () => "request-obsolete",
    });
    relay.attachWindow(oldWindow);
    relay.attachWindow(newWindow);
    relay.installIpc();
    const opening = relay.open(request);

    expect(native.handlers.get("native_browser_relay_ready")?.(
      {}, newWindow, { sender: { id: 19 } },
    )).toBe(false);
    expect(newWindow.webContents.send).not.toHaveBeenCalled();
    expect(native.handlers.get("native_browser_relay_ready")?.(
      {}, newWindow, { sender: { id: 20 } },
    )).toBe(2);
    relay.acknowledge({
      requestId: "request-obsolete", generation: 2,
      workspaceDir: request.workspaceDir, scopeType: request.scopeType, scopeId: request.scopeId,
      ok: true, tabId: request.newTabId, reused: false, created: true,
    });
    await expect(opening).resolves.toEqual({
      tabId: request.newTabId, reused: false, created: true,
    });
  });

  it("cancels stale registration readiness and resumes the transaction after navigation", async () => {
    const win = fakeWindow(18);
    const waitForUi = vi.fn(
      (_tabId: string, _workspaceDir: string, _timeoutMs: number, options: { signal: AbortSignal }) => {
        if (waitForUi.mock.calls.length > 1) return Promise.resolve({});
        return new Promise((_, reject) => {
          options.signal.addEventListener("abort", () => {
            const error = new Error("cancelled");
            error.name = "AbortError";
            reject(error);
          }, { once: true });
        });
      },
    );
    const relay = new BrowserTabRelay({ waitForUi } as any, () => win, {
      timeoutMs: 100, createId: () => "request-navigation",
    });
    relay.attachWindow(win);
    relay.markRendererReady(win);
    const opening = relay.open(request);
    relay.acknowledge({
      requestId: "request-navigation", generation: 1,
      workspaceDir: request.workspaceDir, scopeType: request.scopeType, scopeId: request.scopeId,
      ok: true, tabId: request.newTabId, reused: false, created: true,
    });
    expect(waitForUi).toHaveBeenCalledTimes(1);

    win.webContents.emit("did-start-navigation", {}, "app://reload", false, true);
    relay.markRendererReady(win);
    relay.acknowledge({
      requestId: "request-navigation", generation: 2,
      workspaceDir: request.workspaceDir, scopeType: request.scopeType, scopeId: request.scopeId,
      ok: true, tabId: request.newTabId, reused: false, created: true,
    });

    await expect(opening).resolves.toEqual({
      tabId: request.newTabId, reused: false, created: true,
    });
    expect(waitForUi).toHaveBeenCalledTimes(2);
  });

  it("cancels and rolls back the candidate after acknowledgement loss", async () => {
    vi.useFakeTimers();
    const win = fakeWindow(16);
    const relay = new BrowserTabRelay({ waitForUi: vi.fn() } as any, () => win, {
      timeoutMs: 50, createId: () => "request-timeout",
    });
    relay.attachWindow(win);
    relay.markRendererReady(win);
    const opening = relay.open(request);
    const rejected = expect(opening).rejects.toThrow("did not complete");

    await vi.advanceTimersByTimeAsync(50);
    await rejected;

    expect(sent(win, "browser-tab-open-cancel")).toEqual([
      expect.objectContaining({
        requestId: "request-timeout", newTabId: request.newTabId,
        generation: 1,
      }),
    ]);
    expect(relay.acknowledge({
      requestId: "request-timeout", generation: 1,
      workspaceDir: request.workspaceDir, scopeType: request.scopeType, scopeId: request.scopeId,
      ok: true, tabId: request.newTabId, reused: false, created: true,
    })).toBe(false);
  });

  it("cancels a created tab when registration readiness rejects", async () => {
    const win = fakeWindow(17);
    const waitForUi = vi.fn(async () => { throw new Error("registration timed out"); });
    const relay = new BrowserTabRelay({ waitForUi } as any, () => win, {
      timeoutMs: 100, createId: () => "request-registration",
    });
    relay.attachWindow(win);
    relay.markRendererReady(win);
    const opening = relay.open(request);
    relay.acknowledge({
      requestId: "request-registration", generation: 1,
      workspaceDir: request.workspaceDir, scopeType: request.scopeType, scopeId: request.scopeId,
      ok: true, tabId: request.newTabId, reused: false, created: true,
    });

    await expect(opening).rejects.toThrow("registration timed out");
    expect(sent(win, "browser-tab-open-cancel")).toEqual([
      expect.objectContaining({ requestId: "request-registration", newTabId: request.newTabId }),
    ]);
  });

  it("does not cancel a reused tab when registration readiness rejects", async () => {
    const win = fakeWindow(21);
    const relay = new BrowserTabRelay({
      waitForUi: vi.fn(async () => { throw new Error("registration timed out"); }),
    } as any, () => win, {
      timeoutMs: 100, createId: () => "request-reused",
    });
    relay.attachWindow(win);
    relay.markRendererReady(win);
    const opening = relay.open(request);
    relay.acknowledge({
      requestId: "request-reused", generation: 1,
      workspaceDir: request.workspaceDir, scopeType: request.scopeType, scopeId: request.scopeId,
      ok: true, tabId: "browser:persisted", reused: true, created: false,
    });

    await expect(opening).rejects.toThrow("registration timed out");
    expect(sent(win, "browser-tab-open-cancel")).toEqual([]);
  });

  it("rejects an acknowledgement that claims ownership of a different created tab", async () => {
    const win = fakeWindow(24);
    const waitForUi = vi.fn(async () => ({}));
    const relay = new BrowserTabRelay({ waitForUi } as any, () => win, {
      timeoutMs: 100, createId: () => "request-invalid-owner",
    });
    relay.attachWindow(win);
    relay.markRendererReady(win);
    const opening = relay.open(request);

    relay.acknowledge({
      requestId: "request-invalid-owner", generation: 1,
      workspaceDir: request.workspaceDir, scopeType: request.scopeType, scopeId: request.scopeId,
      ok: true, tabId: "browser:not-the-candidate", reused: false, created: true,
    });

    await expect(opening).rejects.toThrow("invalid browser tab acknowledgement");
    expect(waitForUi).not.toHaveBeenCalled();
    expect(sent(win, "browser-tab-open-cancel")).toEqual([
      expect.objectContaining({ requestId: "request-invalid-owner", newTabId: request.newTabId }),
    ]);
  });

  it("delivers a queued rollback after a timed-out request loses its renderer window", async () => {
    vi.useFakeTimers();
    const oldWindow = fakeWindow(22);
    const newWindow = fakeWindow(23);
    const relay = new BrowserTabRelay({ waitForUi: vi.fn() } as any, () => oldWindow, {
      timeoutMs: 50, createId: () => "request-orphan",
    });
    relay.attachWindow(oldWindow);
    relay.markRendererReady(oldWindow);
    const opening = relay.open(request);
    const rejected = expect(opening).rejects.toThrow("did not complete");

    oldWindow.webContents.isDestroyed = () => true;
    oldWindow.webContents.emit("destroyed");
    await vi.advanceTimersByTimeAsync(50);
    await rejected;
    expect(sent(oldWindow, "browser-tab-open-cancel")).toEqual([]);

    relay.attachWindow(newWindow);
    relay.markRendererReady(newWindow);
    expect(sent(newWindow, "browser-tab-open-cancel")).toEqual([
      expect.objectContaining({ requestId: "request-orphan", generation: 2 }),
    ]);
  });
});
