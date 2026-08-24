import crypto from "node:crypto";
import type { BrowserWindow } from "electron";
import type { BrowserRegistry } from "./browser-registry";
import type { BrowserTabRelayOpenRequest } from "./browser-tab-relay";

type OpenVisibleTab = (request: BrowserTabRelayOpenRequest) => Promise<string>;

export function installGuestBrowserPopupRelay(
  win: BrowserWindow,
  registry: BrowserRegistry,
  openVisibleTab: OpenVisibleTab,
  createTabId: () => string = () => `browser:${crypto.randomUUID()}`,
): void {
  win.webContents.on("did-attach-webview", (_event, guest) => {
    guest.setWindowOpenHandler(({ url }) => {
      const owner = registry.uiOwnerForWebContents(guest.id);
      if (!owner) {
        console.error(`[browser-popup] guest ${guest.id} is not registered to a visible browser tab`);
      } else {
        void openVisibleTab({
          tabId: createTabId(),
          url,
          workspaceDir: owner.workspaceDir,
          source: "popup",
          focusExisting: false,
        }).catch((error) => {
          console.error("[browser-popup] open sibling failed:", error instanceof Error ? error.message : error);
        });
      }
      return { action: "deny" };
    });
  });
}
