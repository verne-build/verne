import { app, BrowserWindow, shell, dialog } from "electron";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ensureDaemon, ensureSidecar, killSidecar, restartDaemon } from "./daemon-supervisor";
import { installRouter, registerNative } from "./ipc-router";
import { createWindow } from "./window";
import { showTestNotification, forgetTab as forgetNotificationTab } from "./native/notifications";
import { buildAppMenu, registerMenuStateCommands } from "./menu";
import { registerAssetSchemePrivilege, handleAssetProtocol } from "./asset-protocol";
import { registerWindowCommands } from "./native/window-cmds";
import { registerDialogCommands } from "./native/dialog-cmds";
import { registerShellCommands } from "./native/shell-cmds";
import { registerMenuCommands } from "./native/menu-cmds";
import { registerBrowserCommands } from "./native/browser";
import { BrowserRegistry } from "./native/browser-registry";
import { BrowserControlServer } from "./native/browser-control-server";
import { createAutomationBrowserSession } from "./native/browser-automation-window";
import { registerReviewCommands } from "./native/review-cmds";
import { registerSettingsCommands, currentSettings } from "./native/settings-cmds";
import { pushTerminalColorsToDaemon } from "./native/terminal-colors";
import { registerShortcutsCommands, stopShortcutsWatcher } from "./native/shortcuts-cmds";
import { registerLspCommands, stopAllLsp, lspInstanceCount, lspPids } from "./native/lsp-cmds";
import { registerMetricsCommands } from "./native/metrics-cmds";
import { registerSpeechIpc } from "./speech/ipc";
import { registerDictationHotkey } from "./speech/hotkey";
import { initAutoUpdater, stopAutoUpdater } from "./native/updater";
import { registerDbCommands } from "./native/db-cmds";
import { getDb } from "./db/connection";
import { getDirectory, resolveWorkspaceRoot } from "./db/directories";
import {
  insertTab,
  getTab,
  getTabs,
  renameTab,
  reorderTabs,
  deleteTab,
  clearStaleTabStates,
  tabDisplayLabels,
  defaultLabel,
} from "./db/tabs";
import type { Tab, CreateTabOpts } from "../../src/types/shared";
import { writeMcpLauncher } from "./mcp/launcher";
import {
  writeNotifyScript,
  removeHooksForClaude,
  removeHooksForCodex,
  removeHooksForCopilot,
  removeHooksForAntigravity,
  removeHooksForCursor,
} from "./native/hook-writer";
import { removePluginForOpencode, removePluginForPi } from "./native/agent-plugins";
import { HOOK_INSTALLERS } from "./native/hook-install-registry";
import { internalDataDir } from "./paths";
import type { DaemonClient } from "./daemon-client";

// Privileged scheme registration MUST happen before app is ready.
registerAssetSchemePrivilege();

// Dev: the unsigned dev binary's keychain ACL changes each launch, so Chromium's
// Safe Storage re-prompts for the login keychain password. Use the in-process
// basic store in dev to skip the prompt; packaged builds use the real OS keychain.
if (!app.isPackaged) app.commandLine.appendSwitch("password-store", "basic");

// Point Chromium's userData (Cookies, Cache, Local Storage, single-instance lock)
// at a `chromium/` subdir of our app-internal data dir. The default is
// appData/<name>, where dev "verne" and prod "Verne" collide on macOS's
// case-insensitive FS — sharing one lock so they can't run together. Nesting it
// under internalDataDir gives dev (build.verne-dev) and prod (build.verne) distinct
// dirs while keeping Chromium's pile out of our own data dir (verne.db, shadow/,
// sockets…). Must precede requestSingleInstanceLock + ready.
const chromiumDataDir = join(internalDataDir, "chromium");
mkdirSync(chromiumDataDir, { recursive: true });
app.setPath("userData", chromiumDataDir);

if (!app.requestSingleInstanceLock()) app.quit();

let win: BrowserWindow | null = null;
let daemon: DaemonClient | null = null;
let sidecar: DaemonClient | null = null;
// notify.sh path written on startup; used to uninstall hooks on before-quit.
let notifyScriptPath: string | null = null;
// CDP browser-automation bridge: registry of attached tab sessions + the TCP
// control server the `verne mcp` process talks to.
const browserRegistry = new BrowserRegistry();
let browserControl: BrowserControlServer | null = null;
const getWindow = (): BrowserWindow => {
  if (!win) throw new Error("no window");
  return win;
};

// Confirm (terminals will die), then hard-restart the daemon in place. Used by
// the menu "Restart Daemon" item.
async function confirmAndRestartDaemon(): Promise<void> {
  if (!daemon || !win) return;
  const { response } = await dialog.showMessageBox(win, {
    type: "warning",
    buttons: ["Cancel", "Restart"],
    defaultId: 1,
    cancelId: 0,
    message: "Restart Daemon?",
    detail: "Running terminal sessions will end.",
  });
  if (response !== 1) return;
  // Cover the window immediately: the daemon is gone for a few seconds, so
  // daemon-backed UI hangs. The renderer shows a "Restarting daemon…" overlay.
  if (win && !win.isDestroyed()) {
    win.webContents.send("daemon-event", "daemon-restart", { active: true });
  }
  try {
    await restartDaemon(daemon);
    // Reload the renderer so it reconnects to the fresh daemon (new ws bridge,
    // empty session set) — without this the window stays bound to the old daemon's
    // now-dead connections and shows stale/disconnected terminals. The reload also
    // clears the overlay (fresh mount); the daemon is already up by here.
    if (win && !win.isDestroyed()) win.webContents.reload();
  } catch (e) {
    console.error("daemon restart failed:", e);
    // Restart failed → no reload happens, so dismiss the overlay explicitly.
    if (win && !win.isDestroyed()) {
      win.webContents.send("daemon-event", "daemon-restart", { active: false });
    }
  }
}

// extra native commands that need closures over main-process state
function registerExtraNatives(): void {
  // debug: fire a test notification (hidden ⌘⌃⇧N shortcut), bypassing the focus gate
  registerNative("notify_test", (_p, win) => showTestNotification(win));
  registerNative("get_resource_path", (p: { name?: string }) => {
    const name = p.name ?? "";
    if (!/^[\w.-]+$/.test(name)) throw new Error("invalid_resource_name");
    const dir = app.isPackaged
      ? process.resourcesPath
      : join(app.getAppPath(), "resources");
    const path = join(dir, name);
    return existsSync(path) ? path : null;
  });
}

// Tab lifecycle spans both processes (Star topology): Electron owns the DB row
// (node:sqlite, slice 5b.2), the daemon owns the live PTY, the sidecar owns
// agent-shadow teardown (DB-free RPCs). These native handlers preserve the
// single renderer call (`tabs_create` etc.).
function registerTabOrchestration(d: DaemonClient, s: DaemonClient): void {
  const emit = (name: string, payload: unknown) =>
    getWindow().webContents.send("daemon-event", name, payload);

  // create: Electron inserts the row + assembles the spawn plan → daemon spawns
  // the PTY. Roll the row back on failure.
  registerNative("tabs_create", async (params: { opts: CreateTabOpts }) => {
    const db = getDb();
    const { opts } = params;
    const dir = getDirectory(db, opts.directoryId);
    if (!dir) throw new Error("directory not found");
    const cwd = opts.cwd ?? dir.path;
    const label = opts.label ?? defaultLabel(getTabs(db, opts.directoryId).length);

    const now = Date.now();
    const tab: Tab = {
      id: crypto.randomUUID(),
      directoryId: opts.directoryId,
      label,
      cwd,
      sortOrder: 0,
      createdAt: now,
      lastAgentType: undefined,
      lastAgentSessionId: undefined,
      lastAgentState: undefined,
      userRenamed: false,
    };
    const env: Record<string, string> = { VERNE_TAB_ID: tab.id };
    const root = resolveWorkspaceRoot(db, opts.directoryId);
    if (root) env.VERNE_WORKSPACE_DIR = root;
    insertTab(db, tab);

    const labels = tabDisplayLabels(db, tab.id);
    const plan = {
      tabId: tab.id,
      cwd,
      env,
      agentSessionId: undefined,
      directoryName: labels.directoryName,
      tabLabel: labels.tabLabel,
    };
    try {
      await d.request("tab_spawn", { plan });
    } catch (e) {
      deleteTab(db, tab.id);
      throw e;
    }
    emit("tab-added", { tab });
    return tab;
  });

  // close: daemon kills the PTY, Electron deletes the row, sidecar tears down the
  // agent shadow (it still owns the in-memory git2 repo + on-disk shadow tree).
  registerNative("tabs_close", async (params: { id: string }) => {
    await d.request("tab_kill", { tabId: params.id }).catch(() => {});
    deleteTab(getDb(), params.id);
    s.request("agent_shadow_cleanup", { tabId: params.id }).catch(() => {});
    emit("tab-deleted", { id: params.id });
    forgetNotificationTab(params.id);
    return true;
  });

  // session-id: assemble a plan from the persisted row, then ensure the daemon
  // has a live PTY (idempotent — returns existing id).
  registerNative("tabs_session_id", (params: { id: string }) => {
    const db = getDb();
    const tab = getTab(db, params.id);
    if (!tab) throw new Error("tab not found");
    const env: Record<string, string> = { VERNE_TAB_ID: tab.id };
    const root = resolveWorkspaceRoot(db, tab.directoryId);
    if (root) env.VERNE_WORKSPACE_DIR = root;
    const labels = tabDisplayLabels(db, params.id);
    const plan = {
      tabId: params.id,
      cwd: tab.cwd,
      env,
      agentSessionId: undefined,
      directoryName: labels.directoryName,
      tabLabel: labels.tabLabel,
    };
    return d.request("tab_spawn", { plan });
  });

  registerNative("tabs_list", (params: { directoryId?: string | null }) =>
    getTabs(getDb(), params.directoryId));

  registerNative("tabs_rename", (params: { id: string; label: string }) => {
    const db = getDb();
    renameTab(db, params.id, params.label);
    const tab = getTab(db, params.id);
    if (!tab) throw new Error("tab gone after rename");
    emit("tab-updated", { tab });
    return tab;
  });

  registerNative("tabs_reorder", (params: { ids: string[] }) => {
    reorderTabs(getDb(), params.ids);
    emit("tabs-reordered", { ids: params.ids });
    return true;
  });
}

app.whenReady().then(async () => {
  handleAssetProtocol();

  // Register all native command handlers before the router can route an invoke.
  registerWindowCommands();
  registerDialogCommands();
  registerShellCommands();
  registerMenuCommands();
  registerBrowserCommands();
  browserRegistry.installIpc();
  registerReviewCommands();
  registerDbCommands(getWindow, () => sidecar);
  registerLspCommands(join(app.getAppPath(), "resources"));
  registerMenuStateCommands(getWindow);
  registerExtraNatives();

  // Dev-only main-process startup phase timing. Mirrors the renderer's
  // [startup] marks, but those are relative to renderer navigation start (which
  // only begins after createWindow below), so anything slow BEFORE the window is
  // invisible there — measure it here.
  const bootT0 = Date.now();
  const since = () => Date.now() - bootT0;
  const timed = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
    if (app.isPackaged) return fn();
    const s = Date.now();
    try { return await fn(); }
    finally { console.log(`[main-startup] ${label}: ${Date.now() - s}ms (@+${since()}ms)`); }
  };

  daemon = await timed("ensureDaemon", () => ensureDaemon());
  sidecar = await timed("ensureSidecar", () => ensureSidecar());
  const d0 = daemon, s0 = sidecar;
  // Sidecar events: best-effort (it's app-lifecycle, freshly spawned above).
  await timed("subscribeEvents:sidecar", () =>
    s0.subscribeEvents().catch((e) => console.error("[startup] sidecar event subscription failed:", e)),
  );
  // Daemon events open a SECOND socket. A reused detached daemon can answer the
  // first connect (ensureDaemon) yet die before this one lands → connect
  // ECONNREFUSED. Don't let that become an unhandled rejection that wedges the
  // app (blank terminals, manual restart): respawn a fresh daemon in place. No
  // sessions are attached yet at startup, so a hard restart is safe here.
  try {
    await timed("subscribeEvents:daemon", () => d0.subscribeEvents());
  } catch (e) {
    console.error("[startup] daemon event subscription failed; respawning daemon:", e);
    await timed("daemon-recovery", () => restartDaemon(d0)).catch((e2) =>
      console.error("[startup] daemon recovery failed:", e2),
    );
  }
  // Settings live in Electron now; seed the sidecar cache before the renderer
  // can issue file-search/worktree requests that read filesExclude/worktreesRoot.
  const startupSettings = currentSettings();
  try { await timed("set_config", () => s0.request("set_config", { settings: startupSettings })); }
  catch (e) { console.error("[settings] startup set_config push failed:", e); }
  try { await timed("terminal_set_colors", () => pushTerminalColorsToDaemon(d0, startupSettings)); }
  catch (e) { console.error("[terminal] startup color push failed:", e); }

  // Register the handlers the renderer needs, then bring the window up. Everything
  // not required for first render (session reconcile, hook install, agent-shadow
  // resync, MCP refresh) is deferred to the background block at the end — it used
  // to be awaited HERE, on the pre-window critical path, delaying first paint by
  // seconds (the daemon/sidecar round-trips + git work in resync).
  registerMetricsCommands(daemon, sidecar, lspInstanceCount, lspPids);
  registerTabOrchestration(daemon, sidecar);
  registerSettingsCommands(sidecar, daemon);

  // Forward `agent-hook-fileops` events from the daemon to the sidecar's
  // agent_shadow_on_hook RPC (fire-and-forget; app may be closing). Cheap to wire
  // up now so no file-op events are missed once agents emit.
  d0.onEvent((name: string, payload: unknown) => {
    if (name !== "agent-hook-fileops") return;
    const p = payload as { agentId?: string; event?: string; toolName?: string; toolInput?: unknown; agentType?: string };
    // Electron resolves the working dir (tab cwd; agentId == tabId) so the
    // sidecar needs no DB. No tab → nothing to snapshot.
    const workingDir = getTab(getDb(), p.agentId ?? "")?.cwd;
    if (!workingDir) return;
    s0.request("agent_shadow_on_hook", {
      agentId: p.agentId ?? "",
      workingDir,
      event: p.event ?? "",
      toolName: p.toolName ?? "",
      toolInput: p.toolInput ?? null,
      agentType: p.agentType ?? "claude",
    }).catch(() => {});
  });

  // Install the invoke router BEFORE creating the window: the renderer fires its
  // startup invokes the moment it mounts, so the handler must already exist or
  // they race ahead → "No handler registered for 'invoke'" (blank workspaces).
  // Event forwarding is safe because win is assigned on the next line before any
  // async event can fire.
  installRouter(daemon, sidecar, getWindow);
  win = createWindow();
  console.log(`[main-startup] window created @+${since()}ms`);

  // Voice dictation: native sherpa-onnx STT + global-ish hotkey on the window.
  registerSpeechIpc(getWindow);
  registerDictationHotkey(win);

  // Start the CDP browser-control server once the window exists. Writes
  // browser-control.json so `verne mcp` can connect.
  browserControl = new BrowserControlServer(browserRegistry, {
    createAutomationSession: createAutomationBrowserSession,
  });
  browserControl.start().catch((e) => console.error("browser-control server failed:", e));

  try { writeMcpLauncher(); } catch (e) { console.error("[mcp] launcher write failed:", e); }

  // Shortcut registry: register handlers + start the real-time watcher. The
  // watcher rebuilds the menu (buildAppMenu reuses the retained restartDaemon
  // callback) and broadcasts `shortcuts-changed` to the renderer.
  registerShortcutsCommands(getWindow, () => buildAppMenu(getWindow));
  buildAppMenu(getWindow, () => void confirmAndRestartDaemon());
  // Auto-update (macOS): check on launch + every 6h, background-download, prompt.
  initAutoUpdater(getWindow);

  // Belt-and-suspenders for <webview> guests: deny popups / external open.
  win.webContents.on("did-attach-webview", (_e, guest) => {
    guest.setWindowOpenHandler(({ url }) => {
      void shell.openExternal(url);
      return { action: "deny" };
    });
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      win = createWindow();
      registerDictationHotkey(win);
    }
  });

  // ---- Deferred startup: nothing here gates first render. Runs AFTER the window
  // is up so its daemon/sidecar round-trips + git work don't delay first paint.
  void (async () => {
    // Reconcile persisted tab state against live PTYs: tabs the (persistent)
    // daemon still has running keep their agent state; the rest are cleared.
    try {
      const liveIds = await timed("reconcile", () => d0.request<string[]>("list_live_tab_ids", null));
      clearStaleTabStates(getDb(), liveIds);
    } catch (e) {
      console.error("session reconcile failed:", e);
    }

    // Hook config: daemon holds the secret + port; Electron writes notify.sh and
    // installs agent hooks. Skip in CI / test envs where VERNE_SKIP_HOOK_INSTALL is set.
    const skipHooks = !!process.env["VERNE_SKIP_HOOK_INSTALL"];
    try {
      const hookCfg = await timed("hooks:get_config", () =>
        d0.request<{ port: number; secret: string; integrations?: { key: string; kind: string }[] }>(
          "__get_hook_config",
          null,
        ),
      );
      notifyScriptPath = writeNotifyScript(internalDataDir, hookCfg.port, hookCfg.secret);
      if (!skipHooks) {
        // Install exactly the agents the daemon registry declares an integration
        // for — keeps the install set and hook authority single-sourced.
        const ctx = { notifyScript: notifyScriptPath, port: hookCfg.port, secret: hookCfg.secret };
        for (const integration of hookCfg.integrations ?? []) {
          const install = HOOK_INSTALLERS[integration.key];
          if (!install) {
            console.warn(`[hooks] no installer for registry integration '${integration.key}'`);
            continue;
          }
          try {
            install(ctx);
          } catch (e) {
            console.error(`[hooks] install ${integration.key} failed:`, e);
          }
        }
      }
    } catch (e) {
      console.error("[hooks] startup hook install failed:", e);
    }

    // Bounded resync: re-baseline tracked files in case the app was closed while
    // an agent was editing files (missed file-op events during app-closed gap).
    try {
      const liveAgentIds = await d0.request<string[]>("list_live_tab_ids", null);
      const agentDirs = liveAgentIds
        .map((id) => ({ agentId: id, workingDir: getTab(getDb(), id)?.cwd }))
        .filter((x): x is { agentId: string; workingDir: string } => !!x.workingDir);
      await timed("agent_shadow_resync", () => s0.request("agent_shadow_resync", { agentDirs }));
    } catch (e) {
      console.error("[hooks] agent shadow resync failed:", e);
    }

    // NOTE: no MCP registration refresh on launch. It shelled out to the
    // claude/codex/cursor/opencode CLIs (`<cli> mcp get …`) — ~6s of serial
    // process spawns that, on the shared sidecar connection, blocked every
    // renderer file/icon/editor RPC behind it. Users refresh registrations
    // on demand from Settings → MCP (SettingsMcp.vue: per-agent + Install All).
    // writeMcpLauncher() above still keeps the launcher script current.
    console.log(`[main-startup] deferred startup done @+${since()}ms`);
  })();
});

app.on("second-instance", () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

// Do NOT kill the daemon here — it must persist so terminal/PTY sessions survive app restarts.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  stopAutoUpdater();
  stopAllLsp();
  stopShortcutsWatcher();
  // Uninstall agent hooks (owned by Electron since slice 4).
  if (notifyScriptPath) {
    try { removeHooksForClaude(notifyScriptPath); } catch (e) { console.error("[hooks] remove claude:", e); }
    try { removeHooksForCodex(notifyScriptPath); } catch (e) { console.error("[hooks] remove codex:", e); }
    try { removeHooksForCopilot(notifyScriptPath); } catch (e) { console.error("[hooks] remove copilot:", e); }
    try { removeHooksForAntigravity(notifyScriptPath); } catch (e) { console.error("[hooks] remove antigravity:", e); }
    try { removeHooksForCursor(notifyScriptPath); } catch (e) { console.error("[hooks] remove cursor:", e); }
    try { removePluginForOpencode(); } catch (e) { console.error("[hooks] remove opencode plugin:", e); }
    try { removePluginForPi(); } catch (e) { console.error("[hooks] remove pi plugin:", e); }
  }
  // Detach all CDP sessions and tear down the control server (removes the
  // browser-control.json descriptor).
  browserRegistry.dispose();
  void browserControl?.stop();
  // The sidecar is tied to this app's lifecycle — stop it cleanly and kill the
  // child as a backstop. The daemon is left running so PTY sessions survive.
  sidecar?.close();
  killSidecar();
});
