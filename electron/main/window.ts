import { BrowserWindow, nativeTheme, shell, type BrowserWindowConstructorOptions } from "electron";
import { join } from "node:path";
import { syncNativeAppearance } from "./native/native-appearance";

type WindowEffectOptions = Pick<
  BrowserWindowConstructorOptions,
  "backgroundColor" | "transparent" | "vibrancy" | "visualEffectState"
>;

export function getWindowEffectOptions(
  platform: NodeJS.Platform,
  reduceTransparency: boolean,
): WindowEffectOptions {
  if (platform !== "darwin") return { backgroundColor: "#0a0a0a" };
  return {
    backgroundColor: "#00000000",
    transparent: true,
    ...(reduceTransparency
      ? {}
      : { vibrancy: "under-window" as const, visualEffectState: "active" as const }),
  };
}

export function createWindow(appearance: unknown = "dark"): BrowserWindow {
  syncNativeAppearance(appearance);
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 940,
    minHeight: 560,
    title: "Verne",
    titleBarStyle: "hidden",
    trafficLightPosition: { x: 12, y: 15 },
    // Dark base so a renderer reload (e.g. after a daemon restart) doesn't flash
    // white before the app paints.
    ...getWindowEffectOptions(process.platform, nativeTheme.prefersReducedTransparency),
    show: false,
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });
  if (process.platform === "darwin") {
    const syncVibrancy = () => {
      win.setVibrancy(nativeTheme.prefersReducedTransparency ? null : "under-window");
    };
    nativeTheme.on("updated", syncVibrancy);
    win.once("closed", () => nativeTheme.removeListener("updated", syncVibrancy));
  }
  win.once("ready-to-show", () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else win.loadFile(join(__dirname, "../renderer/index.html"));
  return win;
}
