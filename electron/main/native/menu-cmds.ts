import { Menu, MenuItem, BrowserWindow } from "electron";
import { registerNative } from "../ipc-router";

// Native context menus. Each mirrors the corresponding Tauri command in
// verne-tauri/src-tauri/src/commands/window.rs exactly: same labels, order,
// separators, enablement, event names and payload shapes. The Tauri commands
// encode the event in the menu item id (`event|json_payload`) and emit on
// click; here we emit directly via the daemon-event channel the renderer's
// useRpc/App.vue listeners already consume.

function emit(win: BrowserWindow, channel: string, payload: unknown) {
  win.webContents.send("daemon-event", channel, payload);
}

export function registerMenuCommands(): void {
  // show_file_context_menu — emits "file-context-menu-action" {path, isDir, action}
  registerNative(
    "show_file_context_menu",
    (p: { path: string; isDir: boolean; hasClipboard: boolean }, win) => {
      const menu = new Menu();
      const item = (label: string, action: string, enabled = true) =>
        menu.append(
          new MenuItem({
            label,
            enabled,
            click: () =>
              emit(win, "file-context-menu-action", {
                path: p.path,
                isDir: p.isDir,
                action,
              }),
          }),
        );
      const sep = () => menu.append(new MenuItem({ type: "separator" }));

      item("Open", "open");
      sep();
      item("Cut", "cut");
      item("Copy", "copy");
      // Paste — only present when there's clipboard content AND target is a dir.
      if (p.hasClipboard && p.isDir) item("Paste", "paste");
      sep();
      item("Copy Path", "copy-path");
      item("Copy Relative Path", "copy-relative-path");
      sep();
      item("Rename", "rename");
      item("Delete", "delete");
      sep();
      item("Reveal in Finder", "reveal");

      menu.popup({ window: win });
      return true;
    },
  );

  // show_batch_file_context_menu — emits "file-context-menu-action" {paths, action}
  registerNative(
    "show_batch_file_context_menu",
    (p: { paths: string[] }, win) => {
      const menu = new Menu();
      const item = (label: string, action: string) =>
        menu.append(
          new MenuItem({
            label,
            click: () =>
              emit(win, "file-context-menu-action", { paths: p.paths, action }),
          }),
        );

      item("Cut", "batch-cut");
      item("Copy", "batch-copy");
      menu.append(new MenuItem({ type: "separator" }));
      item(`Delete ${p.paths.length} Items`, "batch-delete");

      menu.popup({ window: win });
      return true;
    },
  );

  // show_explorer_background_menu — emits "explorer-background-action" {targetDir, action}
  registerNative(
    "show_explorer_background_menu",
    (p: { targetDir: string; hasClipboard: boolean }, win) => {
      const menu = new Menu();
      const item = (label: string, action: string) =>
        menu.append(
          new MenuItem({
            label,
            click: () =>
              emit(win, "explorer-background-action", {
                targetDir: p.targetDir,
                action,
              }),
          }),
        );

      item("New File", "new-file");
      item("New Folder", "new-folder");
      if (p.hasClipboard) item("Paste", "paste");

      menu.popup({ window: win });
      return true;
    },
  );

  // show_settings_context_menu — emits "settings-action" {action}
  registerNative("show_settings_context_menu", (_p: unknown, win) => {
    const menu = new Menu();
    const item = (label: string, action: string) =>
      menu.append(
        new MenuItem({
          label,
          click: () => emit(win, "settings-action", { action }),
        }),
      );

    item("Command Palette", "command-palette");
    item("Settings…", "ui");
    item("Settings (JSON)", "open");
    item("Themes", "themes");

    menu.popup({ window: win });
    return true;
  });
}
