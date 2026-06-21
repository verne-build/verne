// Wraps one browser tab's CDP session (Electron webContents.debugger). Owns the
// enabled domains, bounded network/console buffers, Page-lifecycle tracking, and
// the action primitives used by the browser-control server (snapshot, click,
// fill, select, screenshot, navigate, wait).

export interface Debugger {
  isAttached(): boolean;
  attach(protocolVersion?: string): void;
  detach(): void;
  sendCommand(method: string, params?: object): Promise<any>;
  on(event: "message", cb: (event: unknown, method: string, params: any) => void): void;
  removeAllListeners(event: "message"): void;
}

const BUFFER_MAX = 200;

// AX roles we surface as actionable elements (with refs). Everything else in the
// full tree is structural/text and omitted from the snapshot.
const INTERACTIVE_ROLES = new Set([
  "button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox",
  "menuitem", "tab", "switch", "slider", "listbox", "option",
]);

export interface ConsoleMessage { type: string; text: string; }
export interface NetworkRequest { requestId: string; url: string; status?: number; method?: string; }
export interface SnapshotElement {
  ref: string;
  role: string;
  name: string;
  rect: [number, number, number, number];
  value?: string;
}
export interface Snapshot { url: string; title: string; count: number; elements: SnapshotElement[]; }
export interface BrowserPage {
  reload(): void;
  isDestroyed?(): boolean;
}
export interface CdpSessionOptions { offscreen?: boolean; page?: BrowserPage; }

export class CdpSession {
  private console: ConsoleMessage[] = [];
  private network = new Map<string, NetworkRequest>();
  private networkOrder: string[] = [];
  private lastLifecycle = "";
  // Current top-frame URL, seeded on attach and updated on navigation. Lets
  // browser_list report URLs synchronously without a round-trip per tab.
  private url = "";
  // ref (e1, e2, ...) -> backendDOMNodeId, rebuilt every snapshot.
  private refs = new Map<string, number>();

  constructor(
    readonly tabId: string,
    readonly wcId: number,
    readonly workspaceDir: string,
    private dbg: Debugger,
    private opts: CdpSessionOptions = {},
  ) {}

  async attach(): Promise<void> {
    if (!this.dbg.isAttached()) this.dbg.attach("1.3");
    this.dbg.on("message", (_e, method, params) => this.onEvent(method, params));
    for (const d of ["DOM", "Accessibility", "Network", "Runtime", "Page"]) {
      await this.dbg.sendCommand(`${d}.enable`);
    }
    await this.dbg.sendCommand("Page.setLifecycleEventsEnabled", { enabled: true });
    // Seed the current URL (the page may have loaded before we attached).
    try {
      const { result } = await this.dbg.sendCommand("Runtime.evaluate", {
        expression: "location.href", returnByValue: true,
      });
      if (result?.value) this.url = result.value;
    } catch { /* page not ready; updated on first navigation */ }
  }

  detach(): void {
    try { this.dbg.removeAllListeners("message"); } catch { /* ignore */ }
    try { if (this.dbg.isAttached()) this.dbg.detach(); } catch { /* ignore */ }
    this.console = [];
    this.network.clear();
    this.networkOrder = [];
    this.refs.clear();
    this.url = "";
  }

  // ---- event ingestion ----
  private onEvent(method: string, params: any): void {
    if (method === "Runtime.consoleAPICalled") {
      const text = (params.args ?? []).map((a: any) => a?.value ?? a?.description ?? "").join(" ");
      this.push(this.console, { type: params.type ?? "log", text });
    } else if (method === "Runtime.exceptionThrown") {
      const text = params?.exceptionDetails?.exception?.description
        ?? params?.exceptionDetails?.text ?? "exception";
      this.push(this.console, { type: "error", text });
    } else if (method === "Network.requestWillBeSent") {
      this.putNetwork({ requestId: params.requestId, url: params.request?.url ?? "", method: params.request?.method });
    } else if (method === "Network.responseReceived") {
      const cur = this.network.get(params.requestId) ?? { requestId: params.requestId, url: params.response?.url ?? "" };
      this.putNetwork({ ...cur, url: params.response?.url ?? cur.url, status: params.response?.status });
    } else if (method === "Page.lifecycleEvent") {
      this.lastLifecycle = params?.name ?? this.lastLifecycle;
    } else if (method === "Page.frameNavigated") {
      // Top frame only (no parentId) — ignore sub-frame/iframe navigations.
      if (params?.frame && !params.frame.parentId) this.url = params.frame.url ?? this.url;
    } else if (method === "Page.navigatedWithinDocument") {
      this.url = params?.url ?? this.url;
    }
  }

  private push<T>(arr: T[], item: T): void {
    arr.push(item);
    if (arr.length > BUFFER_MAX) arr.shift();
  }

  private putNetwork(r: NetworkRequest): void {
    if (!this.network.has(r.requestId)) {
      this.networkOrder.push(r.requestId);
      if (this.networkOrder.length > BUFFER_MAX) {
        const evicted = this.networkOrder.shift();
        if (evicted) this.network.delete(evicted);
      }
    }
    this.network.set(r.requestId, r);
  }

  consoleMessages(): ConsoleMessage[] { return [...this.console]; }
  networkRequests(): NetworkRequest[] {
    return this.networkOrder.map((id) => this.network.get(id)!).filter(Boolean);
  }
  lifecycle(): string { return this.lastLifecycle; }
  currentUrl(): string { return this.url; }
  send(method: string, params?: object): Promise<any> { return this.dbg.sendCommand(method, params); }

  async reload(): Promise<void> {
    if (this.opts.page) {
      if (this.opts.page.isDestroyed?.()) throw new Error(`browser tab ${this.tabId} is destroyed`);
      this.opts.page.reload();
      return;
    }
    await this.send("Page.reload");
  }

  async beginNavigate(url: string): Promise<void> {
    this.url = url;
    await this.send("Page.navigate", { url });
  }

  // ---- action primitives ----
  async snapshot(): Promise<Snapshot> {
    this.refs.clear();
    const { nodes } = await this.send("Accessibility.getFullAXTree");
    const elements: SnapshotElement[] = [];
    let i = 0;
    for (const n of nodes ?? []) {
      if (n.ignored) continue;
      const role = n.role?.value ?? "";
      if (!INTERACTIVE_ROLES.has(role)) continue;
      const backend = n.backendDOMNodeId;
      if (typeof backend !== "number") continue;
      let rect: [number, number, number, number] = [0, 0, 0, 0];
      try {
        const { model } = await this.send("DOM.getBoxModel", { backendNodeId: backend });
        const c = model.content; // [x1,y1,x2,y2,x3,y3,x4,y4]
        rect = [Math.round(c[0]), Math.round(c[1]), Math.round(model.width), Math.round(model.height)];
      } catch { /* node off-screen / no box; keep zero rect */ }
      const ref = `e${++i}`;
      this.refs.set(ref, backend);
      const el: SnapshotElement = { ref, role, name: (n.name?.value ?? "").slice(0, 100), rect };
      const val = n.value?.value;
      if (val != null) el.value = String(val).slice(0, 100);
      elements.push(el);
    }
    const { result } = await this.send("Runtime.evaluate", {
      expression: "JSON.stringify({url: location.href, title: document.title})",
      returnByValue: true,
    });
    const meta = result?.value ? JSON.parse(result.value) : { url: "", title: "" };
    return { url: meta.url, title: meta.title, count: elements.length, elements };
  }

  private backendFor(ref: string): number {
    const b = this.refs.get(ref);
    if (b == null) throw new Error(`unknown ref "${ref}" — call snapshot first`);
    return b;
  }

  private async centerOf(backendNodeId: number): Promise<{ x: number; y: number }> {
    const { model } = await this.send("DOM.getBoxModel", { backendNodeId });
    const c = model.content;
    return { x: (c[0] + c[4]) / 2, y: (c[1] + c[5]) / 2 };
  }

  async click(ref: string): Promise<void> {
    const backend = this.backendFor(ref);
    await this.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: backend }).catch(() => {});
    const { x, y } = await this.centerOf(backend);
    const base = { x, y, button: "left", clickCount: 1 };
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", ...base });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base });
  }

  async fill(ref: string, value: string): Promise<void> {
    const backend = this.backendFor(ref);
    await this.send("DOM.focus", { backendNodeId: backend });
    // Select any existing content so insertText replaces it.
    await this.send("Runtime.evaluate", {
      expression: "document.execCommand('selectAll', false, null)",
    }).catch(() => {});
    await this.send("Input.insertText", { text: value });
  }

  async selectOption(ref: string, value: string): Promise<void> {
    const backend = this.backendFor(ref);
    const { object } = await this.send("DOM.resolveNode", { backendNodeId: backend });
    await this.send("Runtime.callFunctionOn", {
      objectId: object.objectId,
      functionDeclaration:
        "function(v){const o=Array.from(this.options||[]).find(o=>o.value===v||o.text===v);" +
        "if(o){this.value=o.value;this.dispatchEvent(new Event('input',{bubbles:true}));" +
        "this.dispatchEvent(new Event('change',{bubbles:true}));}}",
      arguments: [{ value }],
    });
  }

  async screenshotJpeg(): Promise<string> {
    // A background browser tab's <webview> is display:none (RightPanel keeps it
    // mounted but hidden), so it has no compositor surface. The default
    // surface-based capture then blocks until a frame appears — which never
    // happens while hidden — and the agent's browser-control socket times out.
    // Detect the hidden case (guest reports a zero viewport) and force an
    // offscreen render: a device-metrics override gives the page a layout size
    // even at 0×0, and captureBeyondViewport paints to a bitmap off the surface.
    let w = 0, h = 0;
    try {
      const { result } = await this.send("Runtime.evaluate", {
        expression: "[window.innerWidth, window.innerHeight]", returnByValue: true,
      });
      if (Array.isArray(result?.value)) [w, h] = result.value;
    } catch { /* treat as hidden */ }
    const hidden = this.opts.offscreen || !w || !h;
    if (hidden) {
      await this.send("Emulation.setDeviceMetricsOverride", {
        width: 1280, height: 800, deviceScaleFactor: 1, mobile: false,
      });
    }
    try {
      const { data } = await this.send("Page.captureScreenshot", {
        format: "jpeg", quality: 70, captureBeyondViewport: hidden,
      });
      return data; // base64
    } finally {
      if (hidden) await this.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
    }
  }

  async navigate(url: string): Promise<string> {
    await this.send("Page.navigate", { url });
    await this.waitFor("load", 15000).catch(() => {});
    const { result } = await this.send("Runtime.evaluate", { expression: "location.href", returnByValue: true });
    return result?.value ?? url;
  }

  async waitFor(until: "load" | "networkidle" | string, timeoutMs = 10000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const lifecycleTarget = until === "load" ? "load" : until === "networkidle" ? "networkIdle" : null;
    while (Date.now() < deadline) {
      if (lifecycleTarget) {
        if (this.lifecycle() === lifecycleTarget || this.lifecycle() === "load") return;
      } else {
        const { result } = await this.send("Runtime.evaluate", {
          expression: `!!document.querySelector(${JSON.stringify(until)})`,
          returnByValue: true,
        });
        if (result?.value === true) return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`waitFor("${until}") timed out after ${timeoutMs}ms`);
  }
}
