// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { installBrowserTabOpenRequests } from "./browserTabOpenRequests";

const request = {
  requestId: "request-1",
  tabId: "browser:requested",
  url: "https://example.com",
  workspaceDir: "/repo",
  source: "mcp" as const,
  focusExisting: false,
};

describe("browser tab open requests", () => {
  let dispose: (() => void) | undefined;

  afterEach(() => {
    dispose?.();
    dispose = undefined;
  });

  it("opens an explicit visible tab in the active scope and acknowledges it", async () => {
    const openBrowserTab = vi.fn(() => request.tabId);
    const acknowledge = vi.fn(async () => true);
    const revealPanel = vi.fn();
    dispose = installBrowserTabOpenRequests({
      activeScope: () => ({ path: "/repo", scopeType: "directory", scopeId: "dir-1" }),
      tabs: () => [],
      openBrowserTab,
      setActiveId: vi.fn(),
      revealPanel,
      acknowledge,
    });

    window.dispatchEvent(new CustomEvent("browser-tab-open-request", { detail: request }));
    await vi.waitFor(() => expect(acknowledge).toHaveBeenCalled());

    expect(revealPanel).toHaveBeenCalledOnce();
    expect(openBrowserTab).toHaveBeenCalledWith(request.url, undefined, request.tabId);
    expect(acknowledge).toHaveBeenCalledWith({
      requestId: request.requestId,
      tabId: request.tabId,
      workspaceDir: request.workspaceDir,
      ok: true,
    });
  });

  it("rejects a request for a workspace other than the active scope", async () => {
    const openBrowserTab = vi.fn();
    const acknowledge = vi.fn(async () => true);
    dispose = installBrowserTabOpenRequests({
      activeScope: () => ({ path: "/other", scopeType: "directory", scopeId: "dir-2" }),
      tabs: () => [],
      openBrowserTab,
      setActiveId: vi.fn(),
      revealPanel: vi.fn(),
      acknowledge,
    });

    window.dispatchEvent(new CustomEvent("browser-tab-open-request", { detail: request }));
    await vi.waitFor(() => expect(acknowledge).toHaveBeenCalled());

    expect(openBrowserTab).not.toHaveBeenCalled();
    expect(acknowledge).toHaveBeenCalledWith(expect.objectContaining({
      requestId: request.requestId,
      ok: false,
      error: expect.stringContaining("not active"),
    }));
  });

  it("focuses an explicitly requested existing browser without duplicating it", async () => {
    const setActiveId = vi.fn();
    const openBrowserTab = vi.fn();
    const acknowledge = vi.fn(async () => true);
    dispose = installBrowserTabOpenRequests({
      activeScope: () => ({ path: "/repo", scopeType: "directory", scopeId: "dir-1" }),
      tabs: () => [{ kind: "browser", id: request.tabId, label: "Example", browserUrl: request.url }],
      openBrowserTab,
      setActiveId,
      revealPanel: vi.fn(),
      acknowledge,
    });

    window.dispatchEvent(new CustomEvent("browser-tab-open-request", {
      detail: { ...request, focusExisting: true },
    }));
    await vi.waitFor(() => expect(acknowledge).toHaveBeenCalled());

    expect(setActiveId).toHaveBeenCalledWith(request.tabId);
    expect(openBrowserTab).not.toHaveBeenCalled();
    expect(acknowledge).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
  });
});
