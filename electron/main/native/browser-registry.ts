// Maps visible browser tab ids to generation-safe CDP sessions. Renderer
// registrations can overlap while webviews reload, so identity is the exact
// (tabId, guest webContents id) pair rather than tabId alone.
import { webContents } from "electron";
import { registerNative } from "../ipc-router";
import { CdpSession, type Debugger } from "./cdp-session";
import type { BrowserTabScope } from "../../../src/types/shared";

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
  scope?: BrowserTabScope;
  hostWebContentsId?: number;
  automationOwner?: string;
  dispose?: () => void;
  cleanupLifecycle?: () => void;
}
interface PendingRegistration {
  key: string;
  tabId: string;
  wcId: number;
  scope: BrowserTabScope;
  hostWebContentsId: number;
  generation: number;
  session: CdpSession;
  promise: Promise<void>;
  disposed: boolean;
  cleanupLifecycle?: () => void;
}
interface UiWaiter {
  workspaceDir: string;
  hostWebContentsId?: number;
  resolve: (session: CdpSession) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
}
export interface UiWaitOptions {
  hostWebContentsId?: number;
  signal?: AbortSignal;
}

function defaultFactory(tabId: string, wcId: number, workspaceDir: string): CdpSession {
  const wc = webContents.fromId(wcId);
  if (!wc) throw new Error(`webContents ${wcId} not found`);
  const type = wc.getType();
  if (type !== "webview") throw new Error(`browser tab ${tabId} expected webview webContents, got ${type}`);
  return new CdpSession(tabId, wcId, workspaceDir, wc.debugger as unknown as Debugger, { page: wc });
}

function pendingKey(tabId: string, wcId: number): string {
  return `${tabId}:${wcId}`;
}

export class BrowserRegistry {
  private tabs = new Map<string, RegistryEntry>();
  private pending = new Map<string, PendingRegistration>();
  private generations = new Map<string, number>();
  private activeByWorkspace = new Map<string, string>();
  private uiWaiters = new Map<string, Set<UiWaiter>>();

  constructor(private factory: SessionFactory = defaultFactory) {}

  setActive(tabId: string | null, workspaceDir: string): void {
    if (tabId) this.activeByWorkspace.set(workspaceDir, tabId);
    else this.activeByWorkspace.delete(workspaceDir);
  }

  async register(
    tabId: string,
    wcId: number,
    scope: BrowserTabScope,
    hostWebContentsId: number,
  ): Promise<void> {
    const existing = this.tabs.get(tabId);
    if (
      existing?.owner === "ui"
      && existing.session.wcId === wcId
      && existing.hostWebContentsId === hostWebContentsId
      && existing.scope?.path === scope.path
      && existing.scope.scopeId === scope.scopeId
      && existing.scope.scopeType === scope.scopeType
    ) return Promise.resolve();

    const key = pendingKey(tabId, wcId);
    const alreadyPending = this.pending.get(key);
    if (
      alreadyPending
      && alreadyPending.hostWebContentsId === hostWebContentsId
      && alreadyPending.scope.path === scope.path
      && alreadyPending.scope.scopeId === scope.scopeId
      && alreadyPending.scope.scopeType === scope.scopeType
    ) return alreadyPending.promise;

    const generation = (this.generations.get(tabId) ?? 0) + 1;
    this.generations.set(tabId, generation);
    const session = this.factory(tabId, wcId, scope.path);
    const registration = {
      key,
      tabId,
      wcId,
      scope: { ...scope },
      hostWebContentsId,
      generation,
      session,
      disposed: false,
    } as PendingRegistration;
    registration.cleanupLifecycle = this.observeGuest(registration);
    // Publish the pending identity before attach starts. A custom/debugger
    // attach can fail synchronously; cleanup must see and remove this entry.
    let resolveRegistration!: () => void;
    let rejectRegistration!: (error: unknown) => void;
    registration.promise = new Promise<void>((resolve, reject) => {
      resolveRegistration = resolve;
      rejectRegistration = reject;
    });
    this.pending.set(key, registration);
    void this.finishRegistration(registration).then(resolveRegistration, rejectRegistration);
    return registration.promise;
  }

  private async finishRegistration(registration: PendingRegistration): Promise<void> {
    try {
      await registration.session.attach();
      if (
        registration.disposed
        || this.pending.get(registration.key) !== registration
        || this.generations.get(registration.tabId) !== registration.generation
      ) {
        this.disposePending(registration);
        return;
      }

      this.pending.delete(registration.key);
      const existing = this.tabs.get(registration.tabId);
      if (existing) this.disposeEntry(existing);
      const entry: RegistryEntry = {
        session: registration.session,
        owner: "ui",
        scope: registration.scope,
        hostWebContentsId: registration.hostWebContentsId,
        cleanupLifecycle: registration.cleanupLifecycle,
      };
      registration.cleanupLifecycle = undefined;
      this.tabs.set(registration.tabId, entry);
      this.resolveUiWaiters(registration.tabId, entry);
    } catch (error) {
      this.disposePending(registration);
      throw error;
    } finally {
      if (this.pending.get(registration.key) === registration) {
        this.pending.delete(registration.key);
      }
    }
  }

  registerAutomation(tabId: string, session: CdpSession, automationOwner: string, dispose: () => void): void {
    this.generations.set(tabId, (this.generations.get(tabId) ?? 0) + 1);
    this.cancelPendingForTab(tabId);
    const existing = this.tabs.get(tabId);
    if (existing) this.disposeEntry(existing);
    this.tabs.set(tabId, { session, owner: "automation", automationOwner, dispose });
  }

  unregister(tabId: string, wcId: number): void {
    const pending = this.pending.get(pendingKey(tabId, wcId));
    if (pending) {
      this.pending.delete(pending.key);
      this.disposePending(pending);
    }

    const entry = this.tabs.get(tabId);
    if (!entry || entry.session.wcId !== wcId) return;
    this.tabs.delete(tabId);
    this.disposeEntry(entry);
    const hasReplacement = [...this.pending.values()].some((candidate) =>
      candidate.tabId === tabId
      && candidate.scope.path === entry.session.workspaceDir
      && candidate.generation === this.generations.get(tabId));
    if (!hasReplacement && this.activeByWorkspace.get(entry.session.workspaceDir) === tabId) {
      this.activeByWorkspace.delete(entry.session.workspaceDir);
    }
  }

  unregisterUiForHost(hostWebContentsId: number): void {
    for (const registration of [...this.pending.values()]) {
      if (registration.hostWebContentsId === hostWebContentsId) {
        this.unregister(registration.tabId, registration.wcId);
      }
    }
    for (const entry of [...this.tabs.values()]) {
      if (entry.owner === "ui" && entry.hostWebContentsId === hostWebContentsId) {
        this.unregister(entry.session.tabId, entry.session.wcId);
      }
    }
  }

  get(tabId: string, workspaceDir: string): CdpSession {
    const entry = this.tabs.get(tabId);
    const session = entry?.session;
    if (!entry || !session) throw new Error(`browser tab ${tabId} not found`);
    if (session.workspaceDir !== workspaceDir) throw new Error(`tab ${tabId} not in workspace`);
    return session;
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
      const session = entry.session;
      if (
        entry.owner === "automation"
        && entry.automationOwner === automationOwner
        && session.workspaceDir === workspaceDir
      ) return session;
    }
    return null;
  }

  has(tabId: string): boolean {
    return this.tabs.has(tabId);
  }

  uiOwnerForWebContents(wcId: number): { tabId: string; scope: BrowserTabScope } | null {
    for (const entry of this.tabs.values()) {
      if (entry.owner !== "ui" || entry.session.wcId !== wcId || !entry.scope) continue;
      return { tabId: entry.session.tabId, scope: { ...entry.scope } };
    }
    for (const registration of this.pending.values()) {
      if (
        registration.wcId !== wcId
        || registration.disposed
        || registration.generation !== this.generations.get(registration.tabId)
      ) continue;
      return { tabId: registration.tabId, scope: { ...registration.scope } };
    }
    return null;
  }

  waitForUi(
    tabId: string,
    workspaceDir: string,
    timeoutMs: number,
    options: UiWaitOptions = {},
  ): Promise<CdpSession> {
    const entry = this.tabs.get(tabId);
    if (this.matchesWaiter(entry, workspaceDir, options.hostWebContentsId)) {
      return Promise.resolve(entry!.session);
    }
    if (options.signal?.aborted) return Promise.reject(this.abortError(tabId));
    return new Promise((resolve, reject) => {
      const waiter: UiWaiter = {
        workspaceDir,
        hostWebContentsId: options.hostWebContentsId,
        resolve,
        reject,
        signal: options.signal,
        timer: setTimeout(() => {
          this.removeUiWaiter(tabId, waiter);
          reject(new Error(`visible browser tab ${tabId} was not ready within ${timeoutMs}ms`));
        }, timeoutMs),
      };
      if (options.signal) {
        waiter.onAbort = () => {
          this.removeUiWaiter(tabId, waiter);
          reject(this.abortError(tabId));
        };
        options.signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      const waiters = this.uiWaiters.get(tabId) ?? new Set<UiWaiter>();
      waiters.add(waiter);
      this.uiWaiters.set(tabId, waiters);
    });
  }

  private matchesWaiter(
    entry: RegistryEntry | undefined,
    workspaceDir: string,
    hostWebContentsId?: number,
  ): entry is RegistryEntry {
    return Boolean(
      entry?.owner === "ui"
      && entry.session.workspaceDir === workspaceDir
      && (hostWebContentsId === undefined || entry.hostWebContentsId === hostWebContentsId),
    );
  }

  private observeGuest(registration: PendingRegistration): (() => void) | undefined {
    const guest = webContents.fromId(registration.wcId) as
      | { once?: (event: string, listener: () => void) => void; removeListener?: (event: string, listener: () => void) => void }
      | null;
    if (!guest?.once) return undefined;
    const onDestroyed = () => this.unregister(registration.tabId, registration.wcId);
    guest.once("destroyed", onDestroyed);
    return () => guest.removeListener?.("destroyed", onDestroyed);
  }

  private disposePending(registration: PendingRegistration): void {
    if (registration.disposed) return;
    registration.disposed = true;
    registration.cleanupLifecycle?.();
    registration.cleanupLifecycle = undefined;
    registration.session.detach();
  }

  private disposeEntry(entry: RegistryEntry): void {
    entry.cleanupLifecycle?.();
    entry.session.detach();
    entry.dispose?.();
  }

  private cancelPendingForTab(tabId: string): void {
    for (const registration of [...this.pending.values()]) {
      if (registration.tabId !== tabId) continue;
      this.pending.delete(registration.key);
      this.disposePending(registration);
    }
  }

  private resolveUiWaiters(tabId: string, entry: RegistryEntry): void {
    const waiters = this.uiWaiters.get(tabId);
    if (!waiters) return;
    for (const waiter of [...waiters]) {
      if (!this.matchesWaiter(entry, waiter.workspaceDir, waiter.hostWebContentsId)) continue;
      this.removeUiWaiter(tabId, waiter);
      waiter.resolve(entry.session);
    }
  }

  private removeUiWaiter(tabId: string, waiter: UiWaiter): void {
    const waiters = this.uiWaiters.get(tabId);
    if (!waiters) return;
    clearTimeout(waiter.timer);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
    waiters.delete(waiter);
    if (waiters.size === 0) this.uiWaiters.delete(tabId);
  }

  private abortError(tabId: string): Error {
    const error = new Error(`visible browser tab ${tabId} readiness cancelled`);
    error.name = "AbortError";
    return error;
  }

  dispose(): void {
    for (const registration of [...this.pending.values()]) this.disposePending(registration);
    this.pending.clear();
    for (const entry of this.tabs.values()) this.disposeEntry(entry);
    this.tabs.clear();
    this.activeByWorkspace.clear();
    for (const [tabId, waiters] of this.uiWaiters.entries()) {
      for (const waiter of [...waiters]) {
        this.removeUiWaiter(tabId, waiter);
        waiter.reject(new Error("browser registry disposed"));
      }
    }
    this.uiWaiters.clear();
  }

  installIpc(): void {
    registerNative("native_browser_register", async (p: {
      tabId: string;
      wcId: number;
      workspaceDir: string;
      scopeType: BrowserTabScope["scopeType"];
      scopeId: string;
    }, win, event) => {
      if (event.sender.id !== win.webContents.id) throw new Error("stale browser renderer");
      await this.register(
        p.tabId,
        p.wcId,
        { path: p.workspaceDir, scopeType: p.scopeType, scopeId: p.scopeId },
        event.sender.id,
      );
      return true;
    });
    registerNative("native_browser_unregister", (p: { tabId: string; wcId: number }) => {
      this.unregister(p.tabId, p.wcId);
      return true;
    });
    registerNative("native_browser_set_active", (p: { tabId: string | null; workspaceDir: string }, win, event) => {
      if (event.sender.id !== win.webContents.id) return false;
      this.setActive(p.tabId, p.workspaceDir);
      return true;
    });
  }
}
