import { BrowserWindow, shell } from "electron";
import { join } from "node:path";
import { syncNativeAppearance } from "./native/native-appearance";

export function createWindow(appearance: unknown = "dark"): BrowserWindow {
  syncNativeAppearance(appearance);
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 940,
    minHeight: 560,
    title: "Verne",
    titleBarStyle: "hidden",
    trafficLightPosition: { x: 12, y: 16 },
    // Dark base so a renderer reload (e.g. after a daemon restart) doesn't flash
    // white before the app paints.
    backgroundColor: "#0a0a0a",
    show: false,
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });
  win.once("ready-to-show", () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else win.loadFile(join(__dirname, "../renderer/index.html"));
  return win;
}
