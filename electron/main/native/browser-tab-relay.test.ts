import { afterEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ handlers: new Map<string, (params: any) => unknown>() }));

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: class {},
}));
vi.mock("../ipc-router", () => ({
  registerNative: vi.fn((method: string, handler: (params: any) => unknown) => {
    native.handlers.set(method, handler);
  }),
}));

import { BrowserTabRelay } from "./browser-tab-relay";

afterEach(() => vi.useRealTimers());

describe("BrowserTabRelay", () => {
  it("waits for renderer acknowledgement and visible-tab registration", async () => {
    const send = vi.fn();
    const waitForUi = vi.fn(async () => ({ tabId: "browser:explicit" }));
    const relay = new BrowserTabRelay(
      { waitForUi } as any,
      () => ({
        isDestroyed: () => false,
        webContents: { isDestroyed: () => false, send },
      }) as any,
      { timeoutMs: 100, createId: () => "request-1" },
    );

    const opening = relay.open({
      tabId: "browser:explicit",
      url: "https://example.com",
      workspaceDir: "/repo",
      source: "mcp",
      focusExisting: false,
    });
    relay.installIpc();
    expect(send).toHaveBeenCalledWith("daemon-event", "browser-tab-open-request", {
      requestId: "request-1",
      tabId: "browser:explicit",
      url: "https://example.com",
      workspaceDir: "/repo",
      source: "mcp",
      focusExisting: false,
    });

    expect(native.handlers.get("native_browser_tab_open_ack")?.({
      requestId: "request-1",
      tabId: "browser:explicit",
      workspaceDir: "/repo",
      ok: true,
    })).toBe(true);
    await expect(opening).resolves.toBe("browser:explicit");
    expect(waitForUi).toHaveBeenCalledWith("browser:explicit", "/repo", 100);
  });

  it("fails clearly when the renderer rejects the workspace", async () => {
    const relay = new BrowserTabRelay(
      { waitForUi: vi.fn() } as any,
      () => ({
        isDestroyed: () => false,
        webContents: { isDestroyed: () => false, send: vi.fn() },
      }) as any,
      { timeoutMs: 100, createId: () => "request-2" },
    );
    const opening = relay.open({
      tabId: "browser:explicit",
      url: "https://example.com",
      workspaceDir: "/repo",
      source: "mcp",
      focusExisting: false,
    });
    relay.acknowledge({
      requestId: "request-2",
      tabId: "browser:explicit",
      workspaceDir: "/repo",
      ok: false,
      error: "workspace /repo is not active",
    });

    await expect(opening).rejects.toThrow("workspace /repo is not active");
  });

  it("clears a timed-out acknowledgement so a late response is rejected", async () => {
    vi.useFakeTimers();
    const relay = new BrowserTabRelay(
      { waitForUi: vi.fn() } as any,
      () => ({
        isDestroyed: () => false,
        webContents: { isDestroyed: () => false, send: vi.fn() },
      }) as any,
      { timeoutMs: 50, createId: () => "request-timeout" },
    );
    const opening = relay.open({
      tabId: "browser:explicit",
      url: "https://example.com",
      workspaceDir: "/repo",
      source: "mcp",
      focusExisting: false,
    });
    const rejected = expect(opening).rejects.toThrow("did not acknowledge");

    await vi.advanceTimersByTimeAsync(50);

    await rejected;
    expect(relay.acknowledge({
      requestId: "request-timeout",
      tabId: "browser:explicit",
      workspaceDir: "/repo",
      ok: true,
    })).toBe(false);
  });
});
