import crypto from "node:crypto";
import type { BrowserWindow } from "electron";
import type { BrowserRegistry } from "./browser-registry";
import type { BrowserTabRelayOpenRequest } from "./browser-tab-relay";
import type { BrowserTabOpenResult } from "../../../src/types/shared";

type OpenVisibleTab = (request: BrowserTabRelayOpenRequest) => Promise<BrowserTabOpenResult>;

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
          newTabId: createTabId(),
          url,
          workspaceDir: owner.scope.path,
          scopeType: owner.scope.scopeType,
          scopeId: owner.scope.scopeId,
          source: "popup",
          allowReuse: false,
        }).catch((error) => {
          console.error("[browser-popup] open sibling failed:", error instanceof Error ? error.message : error);
        });
      }
      return { action: "deny" };
    });
  });
}
