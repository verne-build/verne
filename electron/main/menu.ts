import { Menu, BrowserWindow, app } from "electron";
import { registerNative } from "./ipc-router";
import { accel } from "./native/shortcuts-cmds";

// Current agent scope, mirrored from the renderer store via the
// `update_agent_scope_menu` command. Drives the View > Agents checkmarks.
// "all" is the default (matches Tauri's initial checked state).
let currentScope = "all";

// Restart-daemon callback supplied by index.ts on first build; retained so menu
// rebuilds (e.g. agent-scope changes) keep Restart Daemon wired.
let restartDaemon: (() => void) | undefined;

// Cached getWindow + updater phase so the updater can flip the "Check for
// Updates…" item to a greyed-out progress label (and back) via a menu rebuild.
let getWindowRef: (() => BrowserWindow) | undefined;
export type UpdaterMenuPhase = "idle" | "checking" | "downloading" | "installing" | "ready";
let updaterPhase: UpdaterMenuPhase = "idle";

function updaterMenuItem(
  send: (action: string) => void,
): Electron.MenuItemConstructorOptions {
  switch (updaterPhase) {
    case "checking":
      return { label: "Checking for Updates…", enabled: false };
    case "downloading":
      return { label: "Downloading Update…", enabled: false };
    case "installing":
      return { label: "Installing Update…", enabled: false };
    case "ready":
      return { label: "Restart to Update", click: () => send("restartToUpdate") };
    default:
      return { label: "Check for Updates…", click: () => send("checkForUpdates") };
  }
}

/**
 * Flips the Verne-menu update item between "Check for Updates…" and a greyed-out
 * phase label ("Downloading Update…", etc). No-ops when the phase is unchanged so
 * frequent progress events don't churn full menu rebuilds.
 */
export function setUpdaterMenuPhase(phase: UpdaterMenuPhase): void {
  if (phase === updaterPhase || !getWindowRef) return;
  updaterPhase = phase;
  buildAppMenu(getWindowRef);
}

/**
 * Builds the native application menu, mirroring the Tauri menu in
 * verne-tauri/src-tauri/src/lib.rs. Each custom item dispatches a
 * `menu-action` event to the renderer (bridged in useRpc.initRpc to a
 * window CustomEvent that App.vue's handleMenuAction switches on).
 *
 * Standard editing/window operations use Electron roles so Copy/Paste/Cut,
 * minimize/maximize, and Quit work through the native responder chain
 * without renderer wiring — matching Tauri's predefined menu items.
 */
export function buildAppMenu(getWindow: () => BrowserWindow, onRestartDaemon?: () => void): void {
  if (onRestartDaemon) restartDaemon = onRestartDaemon;
  getWindowRef = getWindow;
  const send = (action: string, scope?: string) =>
    getWindow().webContents.send("daemon-event", "menu-action", { action, scope });

  const isMac = process.platform === "darwin";

  const template: Electron.MenuItemConstructorOptions[] = [
    // Verne (app) menu — Tauri: About, Settings…(⌘,), Themes…, hide/hideOthers/showAll, Stop Daemon, Quit.
    {
      label: "Verne",
      submenu: [
        { role: "about" },
        updaterMenuItem(send),
        { type: "separator" },
        { label: "Settings…", accelerator: accel("settings"), click: () => send("openSettings") },
        { label: "Themes…", click: () => send("openThemes") },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        // Hard-restarts the detached daemon (shutdown + respawn + reconnect in
        // place). Wired natively in index.ts (confirm dialog → restartDaemon),
        // since the renderer has no part in daemon lifecycle.
        { label: "Restart Daemon", click: () => restartDaemon?.() },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    // File — Tauri: Open Workspace…(⌘O), New Terminal(⌘T), New File(⌘N), sep, New Worktree, sep, Close Tab(⌘W).
    {
      label: "File",
      submenu: [
        { label: "Open Workspace…", accelerator: accel("open-workspace"), click: () => send("openWorkspace") },
        { label: "New Terminal", accelerator: accel("new-terminal"), click: () => send("newTerminal") },
        { label: "New Agent Terminal", accelerator: accel("new-agent-terminal"), click: () => send("newAgentTerminal") },
        { label: "New File", accelerator: accel("new-file"), click: () => send("newFile") },
        { type: "separator" },
        { label: "New Worktree", click: () => send("newWorktree") },
        { type: "separator" },
        { label: "Close Tab", accelerator: accel("close-tab"), click: () => send("closeTab") },
      ],
    },
    // Edit — Tauri: custom Undo(⌘Z)/Redo(⌘⇧Z) routed to Monaco, sep, native Cut/Copy/Paste,
    // sep, custom Select All(⌘A). Undo/Redo/SelectAll are custom because Cocoa's responder
    // actions don't reach Monaco; Cut/Copy/Paste use roles (native responder chain works).
    {
      label: "Edit",
      submenu: [
        { label: "Undo", accelerator: accel("undo"), click: () => send("undo") },
        { label: "Redo", accelerator: accel("redo"), click: () => send("redo") },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { type: "separator" },
        { label: "Select All", accelerator: accel("select-all"), click: () => send("selectAll") },
      ],
    },
    // View — Tauri: Toggle Left(⌘B)/Right(⌘⌥B) panels, sep, Focus Explorer(⌘⇧E)/
    // Source Control(⌃⇧G)/Terminal(⌃`), sep, Agents submenu (scope checkboxes).
    {
      label: "View",
      submenu: [
        { label: "Toggle Left Panel", accelerator: accel("toggle-left-panel"), click: () => send("toggleLeftPanel") },
        { label: "Toggle Right Panel", accelerator: accel("toggle-right-panel"), click: () => send("toggleRightPanel") },
        { type: "separator" },
        { label: "Focus File Explorer", accelerator: accel("focus-file-explorer"), click: () => send("focusExplorer") },
        { label: "Focus Source Control", accelerator: accel("focus-source-control"), click: () => send("focusSourceControl") },
        { label: "Focus Terminal", accelerator: accel("focus-terminal"), click: () => send("focusTerminal") },
        { type: "separator" },
        {
          label: "Agents",
          submenu: [
            {
              label: "Show All Agents",
              type: "checkbox",
              checked: currentScope === "all",
              click: () => send("setAgentScope", "all"),
            },
            {
              label: "Show Current Workspace",
              type: "checkbox",
              checked: currentScope === "current",
              click: () => send("setAgentScope", "current"),
            },
          ],
        },
      ],
    },
    // Go — Tauri: Command Palette(⌘K), Go to File…(⌘P), Run Action…(⌘⇧P), sep,
    // Next Tab(⌘⇧]), Previous Tab(⌘⇧[), Reopen Closed Tab(⌘⇧T).
    {
      label: "Go",
      submenu: [
        { label: "Command Palette", accelerator: accel("command-palette"), click: () => send("paletteAll") },
        { label: "Go to File…", accelerator: accel("go-to-file"), click: () => send("goToFile") },
        { label: "Run Action…", accelerator: accel("run-action"), click: () => send("commandPalette") },
        { type: "separator" },
        { label: "Next Tab", accelerator: accel("next-tab"), click: () => send("nextTab") },
        { label: "Previous Tab", accelerator: accel("prev-tab"), click: () => send("prevTab") },
        { label: "Reopen Closed Tab", accelerator: accel("reopen-closed-tab"), click: () => send("reopenClosedTab") },
      ],
    },
    // Window — Tauri: Minimize, Maximize ("Zoom"), sep, Close Window(⌘⇧W —
    // ⌘W is repurposed for Close Tab), and (debug) Inspect Element(⌘⌥I).
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        { type: "separator" },
        { label: "Close Window", accelerator: accel("close-window"), click: () => getWindow().close() },
        ...(app.isPackaged
          ? []
          : ([
              { type: "separator" },
              {
                label: "Inspect Element",
                accelerator: accel("inspect-element"),
                click: () => getWindow().webContents.toggleDevTools(),
              },
            ] as Electron.MenuItemConstructorOptions[])),
      ],
    },
  ];

  // On non-macOS the leading menu is a regular "Verne" menu rather than the
  // macOS app menu; the template above already uses a plain label so it works
  // on both. (isMac retained for clarity / future platform branches.)
  void isMac;

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * Registers the `update_agent_scope_menu` native command. The renderer calls
 * it as invoke("update_agent_scope_menu", { scope }) whenever the agent scope
 * changes (menu click or sidebar toggle, both via the store watch in App.vue),
 * so we record the scope and rebuild the menu to refresh the checkmarks.
 */
export function registerMenuStateCommands(getWindow: () => BrowserWindow): void {
  registerNative("update_agent_scope_menu", (p: { scope: string }) => {
    currentScope = p?.scope === "current" ? "current" : "all";
    buildAppMenu(getWindow);
    return true;
  });
}
