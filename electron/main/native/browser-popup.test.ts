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
      uiOwnerForWebContents: vi.fn(() => ({ tabId: "browser:source", workspaceDir: "/repo" })),
    };
    const openVisibleTab = vi.fn(async () => "browser:sibling");
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
      tabId: "browser:sibling",
      url: "https://popup.example",
      workspaceDir: "/repo",
      source: "popup",
      focusExisting: false,
    });
  });
});
