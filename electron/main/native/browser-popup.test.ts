import { describe, expect, it, vi } from "vitest";
import { installGuestBrowserPopupRelay } from "./browser-popup";

describe("guest browser popup relay", () => {
  it("denies the guest popup and opens a visible sibling tab in its workspace", async () => {
    let didAttach!: (_event: unknown, guest: any) => void;
    let windowOpen!: (details: { url: string }) => { action: string };
    const win = {
      webContents: {
        on: vi.fn((event: string, handler: typeof didAttach) => {
          if (event === "did-attach-webview") didAttach = handler;
        }),
      },
    };
    const registry = {
      uiOwnerForWebContents: vi.fn(() => ({
        tabId: "browser:source",
        scope: { path: "/worktrees/feature", scopeType: "directory", scopeId: "worktree-1" },
      })),
    };
    const openVisibleTab = vi.fn(async () => ({
      tabId: "browser:sibling", reused: false, created: true,
    }));
    installGuestBrowserPopupRelay(
      win as any,
      registry as any,
      openVisibleTab,
      () => "browser:sibling",
    );

    didAttach({}, {
      id: 42,
      setWindowOpenHandler: (handler: typeof windowOpen) => { windowOpen = handler; },
    });
    expect(windowOpen({ url: "https://popup.example" })).toEqual({ action: "deny" });
    await vi.waitFor(() => expect(openVisibleTab).toHaveBeenCalled());

    expect(registry.uiOwnerForWebContents).toHaveBeenCalledWith(42);
    expect(openVisibleTab).toHaveBeenCalledWith({
      newTabId: "browser:sibling",
      url: "https://popup.example",
      workspaceDir: "/worktrees/feature",
      scopeType: "directory",
      scopeId: "worktree-1",
      source: "popup",
      allowReuse: false,
    });
  });

  it("denies the guest popup without an external fallback when the visible relay fails", async () => {
    let didAttach!: (_event: unknown, guest: any) => void;
    let windowOpen!: (details: { url: string }) => { action: string };
    const win = {
      webContents: {
        on: vi.fn((event: string, handler: typeof didAttach) => {
          if (event === "did-attach-webview") didAttach = handler;
        }),
      },
    };
    const registry = {
      uiOwnerForWebContents: vi.fn(() => ({
        tabId: "browser:source",
        scope: { path: "/repo", scopeType: "directory", scopeId: "dir-1" },
      })),
    };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const openVisibleTab = vi.fn(async () => { throw new Error("renderer unavailable"); });
    installGuestBrowserPopupRelay(win as any, registry as any, openVisibleTab, () => "browser:sibling");
    didAttach({}, {
      id: 42,
      setWindowOpenHandler: (handler: typeof windowOpen) => { windowOpen = handler; },
    });

    expect(windowOpen({ url: "https://popup.example" })).toEqual({ action: "deny" });
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith(
      "[browser-popup] open sibling failed:", "renderer unavailable",
    ));
    expect(openVisibleTab).toHaveBeenCalledOnce();
    error.mockRestore();
  });
});
