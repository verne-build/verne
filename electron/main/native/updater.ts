import { app, type BrowserWindow } from "electron";
import { autoUpdater } from "electron-updater";
import { registerNative } from "../ipc-router";
import { setUpdaterMenuPhase } from "../menu";

type UpdaterEventKind =
  | "checking" | "available" | "not-available" | "progress" | "downloaded" | "error";

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h
const FIRST_CHECK_DELAY_MS = 10_000;

let manualCheck = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;

// In dev the app isn't packaged → autoUpdater can't run unless we opt in with a
// dev-app-update.yml + VERNE_DEV_UPDATES=1.
function feedEnabled(): boolean {
  return app.isPackaged || !!process.env["VERNE_DEV_UPDATES"];
}

export function initAutoUpdater(getWindow: () => BrowserWindow): void {
  registerUpdaterNatives(getWindow);
  if (!feedEnabled()) return;
  if (!app.isPackaged) autoUpdater.forceDevUpdateConfig = true;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  const emit = (kind: UpdaterEventKind, extra: Record<string, unknown> = {}) => {
    const win = getWindow();
    if (win && !win.isDestroyed())
      win.webContents.send("daemon-event", "updater-event", { kind, manual: manualCheck, ...extra });
  };

  autoUpdater.on("checking-for-update", () => { emit("checking"); if (manualCheck) setUpdaterMenuPhase("checking"); });
  autoUpdater.on("update-available", (i) => { emit("available", { version: i.version }); setUpdaterMenuPhase("downloading"); });
  autoUpdater.on("update-not-available", (i) => { emit("not-available", { version: i.version }); setUpdaterMenuPhase("idle"); manualCheck = false; });
  autoUpdater.on("download-progress", (p) => { const percent = Math.round(p.percent); emit("progress", { percent }); setUpdaterMenuPhase(percent >= 100 ? "installing" : "downloading"); });
  autoUpdater.on("update-downloaded", (i) => { emit("downloaded", { version: i.version }); setUpdaterMenuPhase("ready"); manualCheck = false; });
  autoUpdater.on("error", (e) => { emit("error", { message: String(e?.message ?? e ?? "unknown") }); setUpdaterMenuPhase("idle"); manualCheck = false; });

  setTimeout(() => void autoUpdater.checkForUpdates().catch((e) => console.error("[updater] initial check:", e)), FIRST_CHECK_DELAY_MS);
  pollTimer = setInterval(
    () => void autoUpdater.checkForUpdates().catch((e) => console.error("[updater] poll:", e)),
    CHECK_INTERVAL_MS,
  );
}

function registerUpdaterNatives(getWindow: () => BrowserWindow): void {
  // Manual "Check for Updates…" — flags the check so the renderer can show an
  // "up to date" toast (auto checks stay silent when nothing's available).
  registerNative("updater_check", () => {
    manualCheck = true;
    if (!feedEnabled()) {
      const win = getWindow();
      if (win && !win.isDestroyed())
        win.webContents.send("daemon-event", "updater-event", { kind: "not-available", manual: true, dev: true });
      manualCheck = false;
      return null;
    }
    return autoUpdater.checkForUpdates().then(() => null).catch((e) => { manualCheck = false; throw e; });
  });

  registerNative("updater_quit_and_install", () => {
    autoUpdater.quitAndInstall();
    return null;
  });
}

export function stopAutoUpdater(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}
