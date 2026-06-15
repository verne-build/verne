import { dialog } from "electron";
import { registerNative } from "../ipc-router";

export function registerDialogCommands(): void {
  registerNative("pick_directory", async (p: { startingFolder?: string | null }, win) => {
    const r = await dialog.showOpenDialog(win, {
      properties: ["openDirectory", "createDirectory"],
      defaultPath: p.startingFolder ?? undefined,
    });
    return { path: r.canceled || !r.filePaths[0] ? null : r.filePaths[0] };
  });

  registerNative("show_save_dialog", async (p: { defaultPath?: string | null }, win) => {
    const r = await dialog.showSaveDialog(win, { defaultPath: p.defaultPath ?? undefined });
    return r.canceled ? null : (r.filePath ?? null);
  });

  registerNative("show_message_dialog", async (p: { message: string; title?: string; kind?: "info" | "warning" | "error" }, win) => {
    const r = await dialog.showMessageBox(win, {
      type: p.kind ?? "warning",
      message: p.message,
      title: p.title ?? "",
      buttons: ["Cancel", "OK"],
      defaultId: 1,
      cancelId: 0,
      noLink: true,
    });
    return r.response === 1; // true if OK
  });
}
