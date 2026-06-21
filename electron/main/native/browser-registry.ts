// Maps browser tabId (browser:<uuid>) -> live CdpSession. Fed by the renderer via
// native_browser_register / native_browser_unregister (BrowserView.vue dom-ready /
// unmount). The control server reads it to dispatch agent actions, workspace-scoped.
import { webContents } from "electron";
import { registerNative } from "../ipc-router";
import { CdpSession, type Debugger } from "./cdp-session";

export type SessionFactory = (tabId: string, wcId: number, workspaceDir: string) => CdpSession;
export type SessionOwner = "ui" | "automation";
export interface BrowserTabInfo {
  id: string;
  url: string;
  active: boolean;
  owner: SessionOwner;
}
interface RegistryEntry {
  session: CdpSession;
  owner: SessionOwner;
  automationOwner?: string;
  dispose?: () => void;
}

function defaultFactory(tabId: string, wcId: number, workspaceDir: string): CdpSession {
  const wc = webContents.fromId(wcId);
  if (!wc) throw new Error(`webContents ${wcId} not found`);
  return new CdpSession(tabId, wcId, workspaceDir, wc.debugger as unknown as Debugger);
}

export class BrowserRegistry {
  private tabs = new Map<string, RegistryEntry>();
  // Active browser tab per workspace, reported by the renderer when the user
  // switches tabs. Lets browser_list flag which tab the user is looking at.
  private activeByWorkspace = new Map<string, string>();

  constructor(private factory: SessionFactory = defaultFactory) {}

  setActive(tabId: string, workspaceDir: string): void {
    this.activeByWorkspace.set(workspaceDir, tabId);
  }

  async register(tabId: string, wcId: number, workspaceDir: string): Promise<void> {
    const existing = this.tabs.get(tabId);
    if (existing?.owner === "ui" && existing.session.wcId === wcId) return; // idempotent: dom-ready can refire
    if (existing) this.disposeEntry(existing);
    const s = this.factory(tabId, wcId, workspaceDir);
    await s.attach();
    this.tabs.set(tabId, { session: s, owner: "ui" });
  }

  registerAutomation(tabId: string, session: CdpSession, automationOwner: string, dispose: () => void): void {
    const existing = this.tabs.get(tabId);
    if (existing) this.disposeEntry(existing);
    this.tabs.set(tabId, { session, owner: "automation", automationOwner, dispose });
  }

  unregister(tabId: string): void {
    const entry = this.tabs.get(tabId);
    if (entry) { this.disposeEntry(entry); this.tabs.delete(tabId); }
  }

  get(tabId: string, workspaceDir: string): CdpSession {
    const entry = this.tabs.get(tabId);
    const s = entry?.session;
    if (!entry || !s) throw new Error(`browser tab ${tabId} not found`);
    if (s.workspaceDir !== workspaceDir) throw new Error(`tab ${tabId} not in workspace`);
    return s;
  }

  list(workspaceDir: string): BrowserTabInfo[] {
    const active = this.activeByWorkspace.get(workspaceDir);
    return [...this.tabs.values()]
      .filter((entry) => entry.session.workspaceDir === workspaceDir)
      .map((entry) => ({
        id: entry.session.tabId,
        url: entry.session.currentUrl(),
        active: entry.owner === "ui" && entry.session.tabId === active,
        owner: entry.owner,
      }));
  }

  currentUi(workspaceDir: string): BrowserTabInfo | null {
    return this.list(workspaceDir).find((tab) => tab.owner === "ui" && tab.active) ?? null;
  }

  findAutomationByOwner(workspaceDir: string, automationOwner: string): CdpSession | null {
    for (const entry of this.tabs.values()) {
      const s = entry.session;
      if (
        entry.owner === "automation"
        && entry.automationOwner === automationOwner
        && s.workspaceDir === workspaceDir
      ) return s;
    }
    return null;
  }

  has(tabId: string): boolean { return this.tabs.has(tabId); }

  private disposeEntry(entry: RegistryEntry): void {
    entry.session.detach();
    entry.dispose?.();
  }

  // Detach every session (called on app quit).
  dispose(): void {
    for (const entry of this.tabs.values()) this.disposeEntry(entry);
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
