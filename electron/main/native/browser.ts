import { webContents, session } from "electron";
import { registerNative } from "../ipc-router";

function wc(id: number) {
  const c = webContents.fromId(id);
  if (!c) throw new Error(`webview ${id} not found`);
  return c;
}

// Mirrors parse_url in native_browser.rs: if no scheme, prefix https://.
function normalizeUrl(u: string): string {
  if (u.includes("://")) return u;
  return `https://${u}`;
}

// Manual (address-bar) navigation for the browser pane. Agent automation no
// longer lives here — it runs through the CDP browser-control server
// (browser-control-server.ts), which drives webContents.debugger directly.
export function registerBrowserCommands(): void {
  registerNative("native_browser_navigate", async (p: { id: number; url: string }) => {
    const c = wc(p.id);
    try {
      await c.loadURL(normalizeUrl(p.url));
    } catch (e) {
      // Redirects (e.g. bbc.com -> www.bbc.co.uk) abort the original load with
      // ERR_ABORTED (-3); the redirected navigation still proceeds and reports
      // via did-navigate, so this is not a real failure.
      const err = e as { code?: string; errno?: number };
      if (err?.code !== "ERR_ABORTED" && err?.errno !== -3) throw e;
    }
    return c.getURL();
  });
  registerNative("native_browser_back", (p: { id: number }) => {
    const c = wc(p.id);
    if (c.navigationHistory.canGoBack()) c.navigationHistory.goBack();
    return true;
  });
  registerNative("native_browser_forward", (p: { id: number }) => {
    const c = wc(p.id);
    if (c.navigationHistory.canGoForward()) c.navigationHistory.goForward();
    return true;
  });
  registerNative("native_browser_reload", (p: { id: number }) => {
    wc(p.id).reload();
    return true;
  });
  registerNative("native_browser_can_go", (p: { id: number }) => {
    const h = wc(p.id).navigationHistory;
    return { back: h.canGoBack(), forward: h.canGoForward() };
  });
  registerNative("native_browser_reload_hard", (p: { id: number }) => {
    wc(p.id).reloadIgnoringCache();
    return true;
  });
  registerNative("native_browser_clear_cookies", async () => {
    const s = session.fromPartition("persist:verne-browser");
    await s.clearStorageData({ storages: ["cookies"] });
    return true;
  });
  registerNative("native_browser_clear_cache", async () => {
    const s = session.fromPartition("persist:verne-browser");
    await s.clearCache();
    return true;
  });
  registerNative("native_browser_stop", (p: { id: number }) => {
    wc(p.id).stop();
    return true;
  });
  registerNative("native_browser_url", (p: { id: number }) => wc(p.id).getURL());
  registerNative("native_browser_close", (p: { id: number }) => {
    wc(p.id).close();
    return true;
  });
}
