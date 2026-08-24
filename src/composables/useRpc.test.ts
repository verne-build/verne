// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const platform = vi.hoisted(() => ({
  invoke: vi.fn(async () => true),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));

vi.mock("@/platform", () => ({
  invoke: platform.invoke,
  listen: vi.fn(async (event: string, handler: (event: { payload: unknown }) => void) => {
    platform.listeners.set(event, handler);
    return () => platform.listeners.delete(event);
  }),
}));

import { initRpc, useRpc } from "./useRpc";

describe("browser tab RPC bridge", () => {
  beforeEach(() => {
    platform.invoke.mockClear();
    platform.listeners.clear();
  });

  it("forwards main browser-tab requests onto the renderer event bus", async () => {
    const detail = {
      requestId: "request-1",
      tabId: "browser:1",
      url: "https://example.com",
      workspaceDir: "/repo",
      source: "mcp",
      focusExisting: false,
    };
    const received = vi.fn();
    window.addEventListener("browser-tab-open-request", received, { once: true });
    await initRpc();

    platform.listeners.get("browser-tab-open-request")?.({ payload: detail });

    expect(received).toHaveBeenCalledOnce();
    expect((received.mock.calls[0][0] as CustomEvent).detail).toEqual(detail);
  });

  it("acknowledges a browser-tab request through native IPC", async () => {
    const ack = {
      requestId: "request-1",
      tabId: "browser:1",
      workspaceDir: "/repo",
      ok: true,
    };

    await useRpc().request.browserTabOpenAck(ack);

    expect(platform.invoke).toHaveBeenCalledWith("native_browser_tab_open_ack", ack);
  });
});
