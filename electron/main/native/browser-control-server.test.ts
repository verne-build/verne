import { describe, it, expect, afterEach, vi } from "vitest";
import net from "node:net";
import { BrowserControlServer } from "./browser-control-server";

let srv: BrowserControlServer | undefined;
afterEach(async () => { await srv?.stop(); srv = undefined; });

function rpc(port: number, body: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const c = net.connect(port, "127.0.0.1", () => c.write(JSON.stringify(body) + "\n"));
    let buf = "";
    c.on("data", (d) => { buf += d.toString(); if (buf.includes("\n")) { resolve(JSON.parse(buf)); c.end(); } });
    c.on("error", reject);
  });
}

function fakeRegistry() {
  const session = {
    tabId: "browser:a",
    workspaceDir: "/ws",
    currentUrl: vi.fn(() => "http://x"),
    navigate: vi.fn(async () => "http://x/landed"),
    reload: vi.fn(async () => {}),
    snapshot: vi.fn(async () => ({ url: "http://x", title: "T", count: 0, elements: [] })),
    click: vi.fn(async () => {}),
    fill: vi.fn(async () => {}),
    networkRequests: vi.fn(() => [{ requestId: "1", url: "http://x", status: 200 }]),
    consoleMessages: vi.fn(() => [{ type: "log", text: "hi" }]),
  };
  return {
    session,
    get: vi.fn(() => session),
    list: vi.fn(() => [{ id: "browser:a", url: "" }]),
    currentUi: vi.fn(() => ({ id: "browser:a", url: "http://x", active: true, owner: "ui" })),
    has: vi.fn(() => true),
    setActive: vi.fn(),
    findAutomationByOwner: vi.fn((): any => null),
    registerAutomation: vi.fn(),
  };
}

const opts = { secret: "good", writeDescriptor: false };

describe("BrowserControlServer", () => {
  it("rejects a bad secret", async () => {
    srv = new BrowserControlServer(fakeRegistry() as any, opts);
    const port = await srv.start();
    const resp = await rpc(port, { action: "list", secret: "bad", workspaceDir: "/ws" });
    expect(resp.ok).toBe(false);
    expect(resp.error).toMatch(/auth/i);
  });

  it("rejects bad json", async () => {
    srv = new BrowserControlServer(fakeRegistry() as any, opts);
    const port = await srv.start();
    const resp = await new Promise<any>((resolve) => {
      const c = net.connect(port, "127.0.0.1", () => c.write("not json\n"));
      let buf = ""; c.on("data", (d) => { buf += d; if (buf.includes("\n")) { resolve(JSON.parse(buf)); c.end(); } });
    });
    expect(resp).toEqual({ ok: false, error: "bad json" });
  });

  it("dispatches snapshot for a valid secret", async () => {
    srv = new BrowserControlServer(fakeRegistry() as any, opts);
    const port = await srv.start();
    const resp = await rpc(port, { action: "snapshot", tabId: "browser:a", secret: "good", workspaceDir: "/ws" });
    expect(resp.ok).toBe(true);
    expect(JSON.parse(resp.snapshot).title).toBe("T");
  });

  it("serves network + console buffers", async () => {
    srv = new BrowserControlServer(fakeRegistry() as any, opts);
    const port = await srv.start();
    const n = await rpc(port, { action: "network", tabId: "browser:a", secret: "good", workspaceDir: "/ws" });
    expect(n.requests[0].status).toBe(200);
    const con = await rpc(port, { action: "console", tabId: "browser:a", secret: "good", workspaceDir: "/ws" });
    expect(con.messages[0].text).toBe("hi");
  });

  it("returns the current user-visible browser", async () => {
    const reg = fakeRegistry();
    srv = new BrowserControlServer(reg as any, opts);
    const port = await srv.start();
    const resp = await rpc(port, { action: "current", secret: "good", workspaceDir: "/ws" });
    expect(resp).toEqual({ ok: true, browser: { id: "browser:a", url: "http://x", active: true, owner: "ui" } });
    expect(reg.currentUi).toHaveBeenCalledWith("/ws");
  });

  it("returns the navigated url", async () => {
    srv = new BrowserControlServer(fakeRegistry() as any, opts);
    const port = await srv.start();
    const resp = await rpc(port, { action: "navigate", tabId: "browser:a", url: "http://x", secret: "good", workspaceDir: "/ws" });
    expect(resp).toEqual({ ok: true, url: "http://x/landed" });
  });

  it("reloads through the registered browser session", async () => {
    const reg = fakeRegistry();
    srv = new BrowserControlServer(reg as any, opts);
    const port = await srv.start();
    const resp = await rpc(port, { action: "reload", tabId: "browser:a", secret: "good", workspaceDir: "/ws" });
    expect(resp).toEqual({ ok: true });
    expect(reg.session.reload).toHaveBeenCalled();
  });

  it("reports a clean error when the session throws", async () => {
    const reg = fakeRegistry();
    reg.get = vi.fn(() => { throw new Error("tab browser:a not in workspace"); });
    srv = new BrowserControlServer(reg as any, opts);
    const port = await srv.start();
    const resp = await rpc(port, { action: "snapshot", tabId: "browser:a", secret: "good", workspaceDir: "/other" });
    expect(resp.ok).toBe(false);
    expect(resp.error).toMatch(/not in workspace/);
  });

  it("open reuses the current agent's automation tab and navigates it", async () => {
    const reg = fakeRegistry();
    (reg.session as any).currentUrl = vi.fn(() => "https://old.example");
    reg.findAutomationByOwner = vi.fn(() => reg.session);
    srv = new BrowserControlServer(reg as any, opts);
    const port = await srv.start();
    const resp = await rpc(port, { action: "open", url: "https://x.com", automationOwner: "tab-1", secret: "good", workspaceDir: "/ws" });
    expect(resp).toEqual({ ok: true, tabId: "browser:a", reused: true });
    expect(reg.findAutomationByOwner).toHaveBeenCalledWith("/ws", "tab-1");
    expect(reg.session.navigate).toHaveBeenCalledWith("https://x.com");
    expect(reg.setActive).not.toHaveBeenCalled();
    expect(reg.registerAutomation).not.toHaveBeenCalled();
  });

  it("open creates a hidden automation tab when no url matches", async () => {
    const reg = fakeRegistry();
    const created: any[] = [];
    srv = new BrowserControlServer(reg as any, {
      ...opts,
      createAutomationSession: vi.fn(async (tabId, url, workspaceDir) => {
        created.push({ tabId, url, workspaceDir });
        return { session: { ...reg.session, tabId, workspaceDir } as any, dispose: vi.fn() };
      }),
    });
    const port = await srv.start();
    const resp = await rpc(port, { action: "open", url: "https://x.com", secret: "good", workspaceDir: "/ws" });
    expect(resp.ok).toBe(true);
    expect(resp.reused).toBe(false);
    expect(resp.tabId).toMatch(/^browser:/);
    expect(created).toEqual([{ tabId: resp.tabId, url: "https://x.com", workspaceDir: "/ws" }]);
    expect(reg.registerAutomation).toHaveBeenCalledWith(resp.tabId, expect.anything(), "workspace:/ws", expect.any(Function));
  });

  it("open creates a visible scoped tab and waits for renderer readiness", async () => {
    const reg = fakeRegistry();
    reg.list = vi.fn(() => []);
    let markReady!: () => void;
    const ready = new Promise<void>((resolve) => { markReady = resolve; });
    const openVisibleTab = vi.fn(async (request: Record<string, unknown>) => {
      await ready;
      return { tabId: request.newTabId as string, reused: false, created: true };
    });
    srv = new BrowserControlServer(reg as any, { ...opts, openVisibleTab });
    const port = await srv.start();
    const response = rpc(port, {
      action: "open",
      url: "https://x.com",
      secret: "good",
      workspaceDir: "/ws",
    });

    await vi.waitFor(() => expect(openVisibleTab).toHaveBeenCalled());
    const request = openVisibleTab.mock.calls[0][0];
    expect(request).toEqual({
      newTabId: expect.stringMatching(/^browser:/),
      url: "https://x.com",
      workspaceDir: "/ws",
      scopeType: "directory",
      scopeId: "/ws",
      source: "mcp",
      allowReuse: true,
    });
    let settled = false;
    void response.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    markReady();
    await expect(response).resolves.toEqual({ ok: true, tabId: request.newTabId, reused: false });
    expect(reg.registerAutomation).not.toHaveBeenCalled();
  });

  it("delegates reuse to renderer state instead of the mounted registry", async () => {
    const reg = fakeRegistry();
    reg.list = vi.fn(() => [
      { id: "browser:visible", url: "https://x.com/", active: false, owner: "ui" },
    ]);
    const openVisibleTab = vi.fn(async () => ({
      tabId: "browser:persisted", reused: true, created: false,
    }));
    srv = new BrowserControlServer(reg as any, { ...opts, openVisibleTab });
    const port = await srv.start();

    const resp = await rpc(port, {
      action: "open",
      url: "https://x.com",
      secret: "good",
      workspaceDir: "/ws",
    });

    expect(resp).toEqual({ ok: true, tabId: "browser:persisted", reused: true });
    expect(openVisibleTab).toHaveBeenCalledWith({
      newTabId: expect.stringMatching(/^browser:/),
      url: "https://x.com",
      workspaceDir: "/ws",
      scopeType: "directory",
      scopeId: "/ws",
      source: "mcp",
      allowReuse: true,
    });
    expect(reg.list).not.toHaveBeenCalled();
    expect(reg.registerAutomation).not.toHaveBeenCalled();
  });

  it("routes a root-scoped MCP request through its authoritative source worktree", async () => {
    const reg = fakeRegistry();
    const resolveScope = vi.fn(() => ({
      path: "/worktrees/feature", scopeType: "directory" as const, scopeId: "worktree-1",
    }));
    const openVisibleTab = vi.fn(async (request: Record<string, unknown>) => ({
      tabId: request.newTabId as string, reused: false, created: true,
    }));
    srv = new BrowserControlServer(reg as any, { ...opts, resolveScope, openVisibleTab });
    const port = await srv.start();

    const resp = await rpc(port, {
      action: "open", url: "https://x.com", sourceTabId: "terminal:worktree",
      secret: "good", workspaceDir: "/repo",
    });

    expect(resp).toMatchObject({ ok: true, reused: false, tabId: expect.stringMatching(/^browser:/) });
    expect(resolveScope).toHaveBeenCalledWith({
      workspaceDir: "/repo", sourceTabId: "terminal:worktree",
    });
    expect(openVisibleTab).toHaveBeenCalledWith({
      newTabId: expect.stringMatching(/^browser:/),
      url: "https://x.com",
      workspaceDir: "/worktrees/feature",
      scopeType: "directory",
      scopeId: "worktree-1",
      source: "mcp",
      allowReuse: true,
    });
  });

  it("lets persisted renderer state choose reuse when no BrowserRegistry entry is mounted", async () => {
    const reg = fakeRegistry();
    reg.list = vi.fn(() => []);
    const openVisibleTab = vi.fn(async () => ({
      tabId: "browser:persisted", reused: true, created: false,
    }));
    srv = new BrowserControlServer(reg as any, {
      ...opts,
      resolveScope: () => ({ path: "/ws", scopeType: "directory", scopeId: "dir-1" }),
      openVisibleTab,
    });
    const port = await srv.start();

    const resp = await rpc(port, {
      action: "open", url: "example.com/#hash", secret: "good", workspaceDir: "/ws",
    });

    expect(resp).toEqual({ ok: true, tabId: "browser:persisted", reused: true });
    expect(openVisibleTab).toHaveBeenCalledWith(expect.objectContaining({
      url: "https://example.com/#hash", allowReuse: true,
    }));
  });

  it("coalesces concurrent opens for the same scope and normalized URL", async () => {
    const reg = fakeRegistry();
    let resolveOpen!: (value: { tabId: string; reused: boolean; created: boolean }) => void;
    const opened = new Promise<{ tabId: string; reused: boolean; created: boolean }>((resolve) => {
      resolveOpen = resolve;
    });
    const openVisibleTab = vi.fn(() => opened);
    srv = new BrowserControlServer(reg as any, {
      ...opts,
      resolveScope: () => ({ path: "/ws", scopeType: "directory", scopeId: "dir-1" }),
      openVisibleTab,
    });
    const port = await srv.start();

    const first = rpc(port, {
      action: "open", url: "example.com", secret: "good", workspaceDir: "/ws",
    });
    const second = rpc(port, {
      action: "open", url: "https://example.com/", secret: "good", workspaceDir: "/ws",
    });
    await vi.waitFor(() => expect(openVisibleTab).toHaveBeenCalledTimes(1));
    resolveOpen({ tabId: "browser:one", reused: false, created: true });

    await expect(first).resolves.toEqual({ ok: true, tabId: "browser:one", reused: false });
    await expect(second).resolves.toEqual({ ok: true, tabId: "browser:one", reused: true });
  });

  it("open reports a clean error when automation is unavailable", async () => {
    const reg = fakeRegistry();
    srv = new BrowserControlServer(reg as any, opts);
    const port = await srv.start();
    const resp = await rpc(port, { action: "open", url: "http://x", secret: "good", workspaceDir: "/ws" });
    expect(resp.ok).toBe(false);
    expect(resp.error).toMatch(/automation unavailable/);
  });
});
