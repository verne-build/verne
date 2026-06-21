import { describe, it, expect, vi } from "vitest";

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
    await reg.register("browser:a", 1, "/ws1");
    await reg.register("browser:b", 2, "/ws2");

    expect(reg.list("/ws1").map((t) => t.id)).toEqual(["browser:a"]);
    expect(reg.get("browser:a", "/ws1")).toBeTruthy();
    expect(reg.has("browser:a")).toBe(true);
    expect(() => reg.get("browser:a", "/ws2")).toThrow(/workspace/);
    expect(() => reg.get("browser:missing", "/ws1")).toThrow(/not found/);

    reg.unregister("browser:a");
    expect(reg.list("/ws1")).toEqual([]);
    expect(reg.has("browser:a")).toBe(false);
  });

  it("reports live URLs and the active tab in list()", async () => {
    const reg = new BrowserRegistry((tabId, wcId, ws) =>
      fakeSession(tabId, wcId, ws, `http://site/${tabId}`));
    await reg.register("browser:a", 1, "/ws");
    await reg.register("browser:b", 2, "/ws");
    reg.setActive("browser:b", "/ws");
    const list = reg.list("/ws");
    expect(list).toEqual([
      { id: "browser:a", url: "http://site/browser:a", active: false, owner: "ui" },
      { id: "browser:b", url: "http://site/browser:b", active: true, owner: "ui" },
    ]);
    expect(reg.currentUi("/ws")).toEqual({ id: "browser:b", url: "http://site/browser:b", active: true, owner: "ui" });
  });

  it("register is idempotent for the same wcId and re-attaches on a new wcId", async () => {
    const sessions: CdpSession[] = [];
    const reg = new BrowserRegistry((tabId, wcId, ws) => {
      const s = fakeSession(tabId, wcId, ws);
      sessions.push(s);
      return s;
    });
    await reg.register("browser:a", 1, "/ws");
    await reg.register("browser:a", 1, "/ws"); // same wcId -> no new session
    expect(sessions).toHaveLength(1);
    await reg.register("browser:a", 2, "/ws"); // new wcId -> old detached, new attached
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
    await expect(reg.register("browser:a", 1, "/ws")).rejects.toThrow(/expected webview/);
    expect(reg.has("browser:a")).toBe(false);
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

    reg.unregister("browser:auto");
    expect(dispose).toHaveBeenCalled();
  });
});
