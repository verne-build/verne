// Maps browser tabId (browser:<uuid>) -> live CdpSession. Fed by the renderer via
// native_browser_register / native_browser_unregister (BrowserView.vue dom-ready /
// unmount). The control server reads it to dispatch agent actions, workspace-scoped.
import { webContents } from "electron";
import { registerNative } from "../ipc-router";
import { CdpSession, type Debugger } from "./cdp-session";

export type SessionFactory = (tabId: string, wcId: number, workspaceDir: string) => CdpSession;

function defaultFactory(tabId: string, wcId: number, workspaceDir: string): CdpSession {
  const wc = webContents.fromId(wcId);
  if (!wc) throw new Error(`webContents ${wcId} not found`);
  return new CdpSession(tabId, wcId, workspaceDir, wc.debugger as unknown as Debugger);
}

export class BrowserRegistry {
  private tabs = new Map<string, CdpSession>();
  // Active browser tab per workspace, reported by the renderer when the user
  // switches tabs. Lets browser_list flag which tab the user is looking at.
  private activeByWorkspace = new Map<string, string>();

  constructor(private factory: SessionFactory = defaultFactory) {}

  setActive(tabId: string, workspaceDir: string): void {
    this.activeByWorkspace.set(workspaceDir, tabId);
  }

  async register(tabId: string, wcId: number, workspaceDir: string): Promise<void> {
    const existing = this.tabs.get(tabId);
    if (existing && existing.wcId === wcId) return; // idempotent: dom-ready can refire
    if (existing) existing.detach();
    const s = this.factory(tabId, wcId, workspaceDir);
    await s.attach();
    this.tabs.set(tabId, s);
  }

  unregister(tabId: string): void {
    const s = this.tabs.get(tabId);
    if (s) { s.detach(); this.tabs.delete(tabId); }
  }

  get(tabId: string, workspaceDir: string): CdpSession {
    const s = this.tabs.get(tabId);
    if (!s) throw new Error(`browser tab ${tabId} not found`);
    if (s.workspaceDir !== workspaceDir) throw new Error(`tab ${tabId} not in workspace`);
    return s;
  }

  list(workspaceDir: string): Array<{ id: string; url: string; active: boolean }> {
    const active = this.activeByWorkspace.get(workspaceDir);
    return [...this.tabs.values()]
      .filter((s) => s.workspaceDir === workspaceDir)
      .map((s) => ({ id: s.tabId, url: s.currentUrl(), active: s.tabId === active }));
  }

  has(tabId: string): boolean { return this.tabs.has(tabId); }

  // Detach every session (called on app quit).
  dispose(): void {
    for (const s of this.tabs.values()) s.detach();
    this.tabs.clear();
  }

  installIpc(): void {
    registerNative("native_browser_register", async (p: { tabId: string; wcId: number; workspaceDir: string }) => {
      await this.register(p.tabId, p.wcId, p.workspaceDir);
      return true;
    });
    registerNative("native_browser_unregister", (p: { tabId: string }) => {
      this.unregister(p.tabId);
      return true;
    });
    registerNative("native_browser_set_active", (p: { tabId: string; workspaceDir: string }) => {
      this.setActive(p.tabId, p.workspaceDir);
      return true;
    });
  }
}
