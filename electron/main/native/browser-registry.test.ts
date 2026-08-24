import { EventEmitter } from "node:events";
import { beforeEach, describe, it, expect, vi } from "vitest";

// Registry imports ../ipc-router which imports electron at module load. Mock it so
// the suite runs in plain Node. The tests inject a factory, so webContents is unused.
const { mockFromId } = vi.hoisted(() => ({
  mockFromId: vi.fn((): any => null),
}));

vi.mock("electron", () => ({
  webContents: { fromId: mockFromId },
  ipcMain: { handle: () => {} },
  BrowserWindow: class {},
}));

import { BrowserRegistry } from "./browser-registry";
import type { CdpSession } from "./cdp-session";

const scope = (path = "/ws", scopeId = "dir-1") => ({
  path, scopeType: "directory" as const, scopeId,
});

beforeEach(() => {
  mockFromId.mockReset();
  mockFromId.mockReturnValue(null);
});

function fakeSession(tabId: string, wcId: number, ws: string, url = ""): CdpSession {
  return {
    tabId, wcId, workspaceDir: ws,
    attach: vi.fn(async () => {}),
    detach: vi.fn(),
    currentUrl: () => url,
  } as unknown as CdpSession;
}

describe("BrowserRegistry", () => {
  it("registers, scopes by workspace, and unregisters", async () => {
    const reg = new BrowserRegistry((tabId, wcId, ws) => fakeSession(tabId, wcId, ws));
    await reg.register("browser:a", 1, scope("/ws1", "dir-1"), 10);
    await reg.register("browser:b", 2, scope("/ws2", "dir-2"), 10);

    expect(reg.list("/ws1").map((t) => t.id)).toEqual(["browser:a"]);
    expect(reg.get("browser:a", "/ws1")).toBeTruthy();
    expect(reg.has("browser:a")).toBe(true);
    expect(() => reg.get("browser:a", "/ws2")).toThrow(/workspace/);
    expect(() => reg.get("browser:missing", "/ws1")).toThrow(/not found/);

    reg.unregister("browser:a", 1);
    expect(reg.list("/ws1")).toEqual([]);
    expect(reg.has("browser:a")).toBe(false);
  });

  it("reports live URLs and the active tab in list()", async () => {
    const reg = new BrowserRegistry((tabId, wcId, ws) =>
      fakeSession(tabId, wcId, ws, `http://site/${tabId}`));
    await reg.register("browser:a", 1, scope(), 10);
    await reg.register("browser:b", 2, scope(), 10);
    reg.setActive("browser:b", "/ws");
    const list = reg.list("/ws");
    expect(list).toEqual([
      { id: "browser:a", url: "http://site/browser:a", active: false, owner: "ui" },
      { id: "browser:b", url: "http://site/browser:b", active: true, owner: "ui" },
    ]);
    expect(reg.currentUi("/ws")).toEqual({ id: "browser:b", url: "http://site/browser:b", active: true, owner: "ui" });
  });

  it("clears the current browser when the right panel activates a static tab", async () => {
    const reg = new BrowserRegistry((tabId, wcId, ws) => fakeSession(tabId, wcId, ws, "https://example.com"));
    await reg.register("browser:a", 1, scope(), 10);
    reg.setActive("browser:a", "/ws");

    reg.setActive(null, "/ws");

    expect(reg.currentUi("/ws")).toBeNull();
    expect(reg.list("/ws")[0].active).toBe(false);
  });

  it("does not let an old browser unregister clear a newer active browser", async () => {
    const reg = new BrowserRegistry((tabId, wcId, ws) => fakeSession(tabId, wcId, ws));
    await reg.register("browser:old", 1, scope(), 10);
    await reg.register("browser:new", 2, scope(), 10);
    reg.setActive("browser:new", "/ws");

    reg.unregister("browser:old", 1);

    expect(reg.currentUi("/ws")?.id).toBe("browser:new");
  });

  it("resolves UI ownership and readiness from the guest webContents id", async () => {
    const reg = new BrowserRegistry((tabId, wcId, ws) => fakeSession(tabId, wcId, ws));
    const ready = reg.waitForUi("browser:a", "/ws", 100);

    await reg.register("browser:a", 42, scope(), 10);

    await expect(ready).resolves.toMatchObject({ tabId: "browser:a", wcId: 42, workspaceDir: "/ws" });
    expect(reg.uiOwnerForWebContents(42)).toEqual({ tabId: "browser:a", scope: scope() });
  });

  it("register is idempotent for the same wcId and re-attaches on a new wcId", async () => {
    const sessions: CdpSession[] = [];
    const reg = new BrowserRegistry((tabId, wcId, ws) => {
      const s = fakeSession(tabId, wcId, ws);
      sessions.push(s);
      return s;
    });
    await reg.register("browser:a", 1, scope(), 10);
    await reg.register("browser:a", 1, scope(), 10); // same wcId -> no new session
    expect(sessions).toHaveLength(1);
    await reg.register("browser:a", 2, scope(), 10); // new wcId -> old detached, new attached
    expect(sessions).toHaveLength(2);
    expect(sessions[0].detach).toHaveBeenCalled();
    expect(reg.get("browser:a", "/ws").wcId).toBe(2);
  });

  it("rejects non-webview webContents", async () => {
    mockFromId.mockReturnValueOnce({
      getType: () => "window",
      debugger: {},
    });
    const reg = new BrowserRegistry();
    await expect(reg.register("browser:a", 1, scope(), 10)).rejects.toThrow(/expected webview/);
    expect(reg.has("browser:a")).toBe(false);
  });

  it("removes a synchronously failed pending attach so the same guest can retry", async () => {
    let attempts = 0;
    const reg = new BrowserRegistry((tabId, wcId, ws) => {
      const session = fakeSession(tabId, wcId, ws);
      attempts++;
      if (attempts === 1) session.attach = vi.fn(() => { throw new Error("attach failed"); });
      return session;
    });

    await expect(reg.register("browser:a", 1, scope(), 10)).rejects.toThrow("attach failed");
    await expect(reg.register("browser:a", 1, scope(), 10)).resolves.toBeUndefined();

    expect(attempts).toBe(2);
    expect(reg.has("browser:a")).toBe(true);
  });

  it("tracks automation tabs by owner without marking them active", async () => {
    const reg = new BrowserRegistry((tabId, wcId, ws) => fakeSession(tabId, wcId, ws));
    const dispose = vi.fn();
    const automation = fakeSession("browser:auto", 9, "/ws", "https://x.test");
    reg.registerAutomation("browser:auto", automation, "terminal-tab-1", dispose);

    expect(reg.findAutomationByOwner("/ws", "terminal-tab-1")).toBe(automation);
    expect(reg.findAutomationByOwner("/ws", "terminal-tab-2")).toBeNull();
    expect(reg.list("/ws")).toEqual([
      { id: "browser:auto", url: "https://x.test", active: false, owner: "automation" },
    ]);
    expect(reg.currentUi("/ws")).toBeNull();

    reg.unregister("browser:auto", 9);
    expect(dispose).toHaveBeenCalled();
  });

  it("invalidates a deferred attach when that exact webContents unregisters", async () => {
    let finishAttach!: () => void;
    const session = fakeSession("browser:a", 1, "/ws");
    session.attach = vi.fn(() => new Promise<void>((resolve) => { finishAttach = resolve; }));
    const reg = new BrowserRegistry(() => session);

    const registering = reg.register("browser:a", 1, scope(), 10);
    reg.unregister("browser:a", 1);
    finishAttach();
    await registering;

    expect(reg.has("browser:a")).toBe(false);
    expect(session.detach).toHaveBeenCalledOnce();
  });

  it("does not let an older deferred attach overwrite a same-id replacement", async () => {
    let finishOld!: () => void;
    const sessions: CdpSession[] = [];
    const reg = new BrowserRegistry((tabId, wcId, ws) => {
      const session = fakeSession(tabId, wcId, ws);
      if (wcId === 1) session.attach = vi.fn(() => new Promise<void>((resolve) => { finishOld = resolve; }));
      sessions.push(session);
      return session;
    });

    const oldRegistration = reg.register("browser:a", 1, scope(), 10);
    await reg.register("browser:a", 2, scope(), 10);
    finishOld();
    await oldRegistration;

    expect(reg.get("browser:a", "/ws").wcId).toBe(2);
    expect(sessions[0].detach).toHaveBeenCalledOnce();
  });

  it("does not expose an older pending generation as the popup owner", async () => {
    let finishOld!: () => void;
    const reg = new BrowserRegistry((tabId, wcId, ws) => {
      const session = fakeSession(tabId, wcId, ws);
      if (wcId === 1) session.attach = vi.fn(() => new Promise<void>((resolve) => { finishOld = resolve; }));
      return session;
    });

    const oldRegistration = reg.register("browser:a", 1, scope(), 10);
    await reg.register("browser:a", 2, scope(), 10);

    expect(reg.uiOwnerForWebContents(1)).toBeNull();
    expect(reg.uiOwnerForWebContents(2)).toEqual({ tabId: "browser:a", scope: scope() });
    finishOld();
    await oldRegistration;
  });

  it("ignores a stale unregister for an older same-id webContents", async () => {
    const reg = new BrowserRegistry((tabId, wcId, ws) => fakeSession(tabId, wcId, ws));
    await reg.register("browser:a", 1, scope(), 10);
    await reg.register("browser:a", 2, scope(), 10);
    reg.setActive("browser:a", "/ws");

    reg.unregister("browser:a", 1);

    expect(reg.get("browser:a", "/ws").wcId).toBe(2);
    expect(reg.currentUi("/ws")?.id).toBe("browser:a");
  });

  it("exposes pending UI ownership so an early popup keeps the source scope", async () => {
    let finishAttach!: () => void;
    const session = fakeSession("browser:a", 42, "/worktrees/feature");
    session.attach = vi.fn(() => new Promise<void>((resolve) => { finishAttach = resolve; }));
    const reg = new BrowserRegistry(() => session);

    const registering = reg.register("browser:a", 42, scope("/worktrees/feature", "worktree-1"), 10);
    expect(reg.uiOwnerForWebContents(42)).toEqual({
      tabId: "browser:a", scope: scope("/worktrees/feature", "worktree-1"),
    });
    finishAttach();
    await registering;
  });

  it("waits for a registration owned by the requested renderer window", async () => {
    const reg = new BrowserRegistry((tabId, wcId, ws) => fakeSession(tabId, wcId, ws));
    await reg.register("browser:a", 1, scope(), 10);
    const ready = reg.waitForUi("browser:a", "/ws", 100, { hostWebContentsId: 20 });
    let settled = false;
    void ready.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    await reg.register("browser:a", 2, scope(), 20);
    await expect(ready).resolves.toMatchObject({ wcId: 2 });
  });

  it("cleans current and pending registrations when their guest or host is destroyed", async () => {
    const guest = new EventEmitter();
    mockFromId.mockReturnValue(guest);
    const reg = new BrowserRegistry((tabId, wcId, ws) => fakeSession(tabId, wcId, ws));
    await reg.register("browser:a", 1, scope(), 30);
    guest.emit("destroyed");
    expect(reg.has("browser:a")).toBe(false);

    await reg.register("browser:b", 2, scope(), 31);
    reg.unregisterUiForHost(31);
    expect(reg.has("browser:b")).toBe(false);
  });
});
