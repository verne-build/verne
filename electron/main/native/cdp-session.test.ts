import { describe, it, expect, vi } from "vitest";
import { CdpSession, type Debugger } from "./cdp-session";

function mockDebugger() {
  const handlers: Record<string, (e: unknown, method: string, params: any) => void> = {};
  const sent: Array<{ method: string; params?: any }> = [];
  const dbg: Debugger & { fire: (m: string, p: any) => void } = {
    isAttached: () => true,
    attach: vi.fn(),
    detach: vi.fn(),
    sendCommand: vi.fn(async (method: string, params?: object) => {
      sent.push({ method, params });
      if (method === "Accessibility.getFullAXTree") return { nodes: [] };
      return {};
    }),
    on: (event: string, cb: any) => { if (event === "message") handlers.message = cb; },
    removeAllListeners: vi.fn(),
    fire: (m: string, p: any) => handlers.message?.({}, m, p),
  };
  return { dbg, sent };
}

describe("CdpSession", () => {
  it("attaches and enables the five domains + lifecycle", async () => {
    const { dbg, sent } = mockDebugger();
    const s = new CdpSession("browser:t1", 42, "/ws", dbg);
    await s.attach();
    const methods = sent.map((c) => c.method);
    expect(methods).toEqual(expect.arrayContaining([
      "DOM.enable", "Accessibility.enable", "Network.enable", "Runtime.enable", "Page.enable",
      "Page.setLifecycleEventsEnabled",
    ]));
  });

  it("buffers console + network events (bounded)", async () => {
    const { dbg } = mockDebugger();
    const s = new CdpSession("browser:t1", 42, "/ws", dbg);
    await s.attach();
    dbg.fire("Runtime.consoleAPICalled", { type: "log", args: [{ value: "hi" }] });
    dbg.fire("Network.responseReceived", { requestId: "1", response: { url: "http://x", status: 200 } });
    expect(s.consoleMessages()).toHaveLength(1);
    expect(s.networkRequests()).toHaveLength(1);
    expect(s.consoleMessages()[0].text).toContain("hi");
    expect(s.networkRequests()[0].status).toBe(200);
  });

  it("tracks the top-frame URL from navigation events", async () => {
    const { dbg } = mockDebugger();
    const s = new CdpSession("browser:t1", 42, "/ws", dbg);
    await s.attach();
    dbg.fire("Page.frameNavigated", { frame: { url: "http://a.com/", id: "1" } }); // top frame, no parentId
    expect(s.currentUrl()).toBe("http://a.com/");
    dbg.fire("Page.frameNavigated", { frame: { url: "http://iframe/", parentId: "1" } }); // sub-frame ignored
    expect(s.currentUrl()).toBe("http://a.com/");
    dbg.fire("Page.navigatedWithinDocument", { url: "http://a.com/#x" });
    expect(s.currentUrl()).toBe("http://a.com/#x");
  });

  it("reloads through the owning page when available", async () => {
    const { dbg, sent } = mockDebugger();
    const page = { reload: vi.fn(), isDestroyed: vi.fn(() => false) };
    const s = new CdpSession("browser:t1", 42, "/ws", dbg, { page });
    await s.reload();
    expect(page.reload).toHaveBeenCalled();
    expect(sent.some((c) => c.method === "Page.reload")).toBe(false);
  });

  it("falls back to CDP reload without an owning page", async () => {
    const { dbg, sent } = mockDebugger();
    const s = new CdpSession("browser:t1", 42, "/ws", dbg);
    await s.reload();
    expect(sent).toContainEqual({ method: "Page.reload", params: undefined });
  });

  it("snapshot assigns refs to interactive AX nodes only", async () => {
    const { dbg, sent } = mockDebugger();
    (dbg.sendCommand as any).mockImplementation(async (m: string, params?: any) => {
      sent.push({ method: m, params });
      if (m === "Accessibility.getFullAXTree") return { nodes: [
        { nodeId: "1", role: { value: "button" }, name: { value: "OK" }, backendDOMNodeId: 11, ignored: false },
        { nodeId: "2", role: { value: "text" }, name: { value: "hi" }, backendDOMNodeId: 12, ignored: false },
      ]};
      if (m === "DOM.getBoxModel") return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10], width: 10, height: 10 } };
      if (m === "Runtime.evaluate") return { result: { value: JSON.stringify({ url: "http://x", title: "T" }) } };
      return {};
    });
    const s = new CdpSession("browser:t1", 42, "/ws", dbg);
    await s.attach();
    const snap = await s.snapshot();
    expect(snap.elements).toHaveLength(1);
    expect(snap.elements[0].ref).toBe("e1");
    expect(snap.elements[0].role).toBe("button");
    expect(snap.title).toBe("T");
  });

  it("click resolves a ref and dispatches mouse press+release", async () => {
    const { dbg, sent } = mockDebugger();
    (dbg.sendCommand as any).mockImplementation(async (m: string, params?: any) => {
      sent.push({ method: m, params });
      if (m === "Accessibility.getFullAXTree") return { nodes: [
        { nodeId: "1", role: { value: "button" }, name: { value: "OK" }, backendDOMNodeId: 11, ignored: false },
      ]};
      if (m === "DOM.getBoxModel") return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10], width: 10, height: 10 } };
      if (m === "Runtime.evaluate") return { result: { value: JSON.stringify({ url: "http://x", title: "T" }) } };
      return {};
    });
    const s = new CdpSession("browser:t1", 42, "/ws", dbg);
    await s.attach();
    await s.snapshot();
    sent.length = 0;
    await s.click("e1");
    const mouse = sent.filter((c) => c.method === "Input.dispatchMouseEvent");
    expect(mouse).toHaveLength(2);
    expect(mouse[0].params.type).toBe("mousePressed");
    expect(mouse[1].params.type).toBe("mouseReleased");
  });

  it("click on an unknown ref throws a re-snapshot hint", async () => {
    const { dbg } = mockDebugger();
    const s = new CdpSession("browser:t1", 42, "/ws", dbg);
    await s.attach();
    await expect(s.click("e9")).rejects.toThrow(/snapshot/);
  });

  it("screenshot of a visible tab uses a plain surface capture (no metrics override)", async () => {
    const { dbg, sent } = mockDebugger();
    (dbg.sendCommand as any).mockImplementation(async (m: string, params?: any) => {
      sent.push({ method: m, params });
      if (m === "Runtime.evaluate") return { result: { value: [1280, 800] } };
      if (m === "Page.captureScreenshot") return { data: "JPEGBYTES" };
      return {};
    });
    const s = new CdpSession("browser:t1", 42, "/ws", dbg);
    await s.attach();
    sent.length = 0;
    const data = await s.screenshotJpeg();
    expect(data).toBe("JPEGBYTES");
    expect(sent.some((c) => c.method === "Emulation.setDeviceMetricsOverride")).toBe(false);
    const shot = sent.find((c) => c.method === "Page.captureScreenshot");
    expect(shot?.params.captureBeyondViewport).toBeFalsy();
  });

  it("screenshot of a hidden (display:none) tab forces an offscreen render", async () => {
    const { dbg, sent } = mockDebugger();
    (dbg.sendCommand as any).mockImplementation(async (m: string, params?: any) => {
      sent.push({ method: m, params });
      // Hidden <webview>: guest reports a zero viewport.
      if (m === "Runtime.evaluate") return { result: { value: [0, 0] } };
      if (m === "Page.captureScreenshot") return { data: "OFFSCREEN" };
      return {};
    });
    const s = new CdpSession("browser:t1", 42, "/ws", dbg);
    await s.attach();
    sent.length = 0;
    const data = await s.screenshotJpeg();
    expect(data).toBe("OFFSCREEN");
    const methods = sent.map((c) => c.method);
    expect(methods).toContain("Emulation.setDeviceMetricsOverride");
    expect(methods).toContain("Emulation.clearDeviceMetricsOverride"); // restored after
    const shot = sent.find((c) => c.method === "Page.captureScreenshot");
    expect(shot?.params.captureBeyondViewport).toBe(true);
  });
});
