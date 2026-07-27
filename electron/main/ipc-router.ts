import { ipcMain, BrowserWindow } from "electron";
import type { DaemonClient } from "./daemon-client";
import { handleTabUpdate } from "./native/notifications";
import { getDb } from "./db/connection";
import { updateTabPresentationSnapshot } from "./db/tabs";
import { handleSessionCwd } from "./scope-repin";

type Handler = (params: any, win: BrowserWindow) => Promise<unknown> | unknown;

const nativeHandlers = new Map<string, Handler>();
export function registerNative(method: string, handler: Handler): void {
  nativeHandlers.set(method, handler);
}

// Methods served by the lean daemon (live PTYs + canonical agent status).
// goes to the sidecar. The composite tab flows (tabs_create/tabs_close/
// tabs_session_id) are NOT here — they're native handlers that orchestrate both
// processes (registered in index.ts).
const DAEMON_METHODS = new Set<string>([
  "ping",
  "get_ws_port",
  "get_daemon_diagnostics",
  "create_terminal",
  "kill_terminal",
  "terminal_set_colors",
  "terminal_set_cursor",
  "tabs_has_running_child",
  // internal PTY methods used by the tab-orchestration native handlers
  "tab_spawn",
  "tab_kill",
  "tab_resize",
  "tab_snapshot",
  "list_live_tab_ids",
  // hook config + agent states (daemon owns these after slice 4)
  "__get_hook_config",
  "get_agent_states",
  "__explain_detection",
]);

export function installRouter(
  daemon: DaemonClient,
  sidecar: DaemonClient,
  getWindow: () => BrowserWindow,
): void {
  ipcMain.handle("invoke", async (_e, method: string, params: unknown) => {
    try {
      const native = nativeHandlers.get(method);
      if (native) return await native(params ?? {}, getWindow());
      const client = DAEMON_METHODS.has(method) ? daemon : sidecar;
      return await client.request(method, params ?? null);
    } catch (e) {
      // Name the method so backend errors (e.g. ENOENT from a stale cwd) are
      // attributable instead of surfacing as a bare "handler for 'invoke'" error.
      console.error(`[invoke] ${method} failed:`, e instanceof Error ? e.message : e);
      throw e;
    }
  });

  // Forward events from BOTH processes to the renderer as "daemon-event".
  const forward = makeForward(getWindow, sidecar);
  daemon.onEvent(forward);
  sidecar.onEvent(forward);
}

// The daemon survives app close and keeps streaming events; on macOS the app
// outlives a closed window. So forwarding must tolerate "window gone" — send to
// a destroyed webContents throws "Object has been destroyed" (uncaught → fatal).
export function makeForward(getWindow: () => BrowserWindow, sidecar: DaemonClient) {
  return (name: string, payload: unknown) => {
    const update = payload as Record<string, unknown>;
    // session-cwd is main-internal: resolve a scope re-pin, never forwarded raw.
    if (name === "session-cwd") {
      void handleSessionCwd(payload as { tabId: string; cwd: string }, {
        db: getDb(),
        sidecarRequest: (method, params) => sidecar.request(method, params),
        broadcast: (n, p) => {
          try {
            const win = getWindow();
            if (win.isDestroyed() || win.webContents.isDestroyed()) return;
            win.webContents.send("daemon-event", n, p);
          } catch { /* window gone */ }
        },
      }).catch((e) => console.error("[scope-repin] session-cwd:", e));
      return;
    }
    // agent-title-requested is main-internal: the index.ts d0.onEvent listener
    // does the generation work (shell out, persist, broadcast tab-title-generated).
    // Prompts here can carry hook bodies up to ~4MB — never structured-clone
    // that raw payload into the renderer, which has no listener for it anyway.
    if (name === "agent-title-requested") return;
    if (name === "tab-updated") {
      try {
        updateTabPresentationSnapshot(getDb(), {
          tabId: typeof update.tabId === "string" ? update.tabId : "",
          agentType: typeof update.agentType === "string" ? update.agentType : null,
          agentState: typeof update.agentState === "string" ? update.agentState : null,
          sessionId:
            typeof update.lastAgentSessionId === "string"
              ? update.lastAgentSessionId
              : null,
          displayTitle: typeof update.displayTitle === "string" ? update.displayTitle : null,
        });
      } catch (e) {
        console.error("[agent-status] persist snapshot:", e);
      }
    }

    let win: BrowserWindow;
    try { win = getWindow(); } catch { return; }
    if (win.isDestroyed() || win.webContents.isDestroyed()) return;
    // Native notifications consume the same canonical transition stream.
    if (name === "tab-updated") {
      try { handleTabUpdate(update, win); }
      catch (e) { console.error("[notifications] handleTabUpdate:", e); }
    }
    win.webContents.send("daemon-event", name, payload);
  };
}
