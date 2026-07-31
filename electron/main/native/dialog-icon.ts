import { app, nativeImage, type NativeImage } from "electron";
import { join } from "node:path";

// macOS resolves + composites the app icon when a message box is SHOWN, so the
// first warning dialog of a session pops with an empty icon well that fills in a
// beat later. Load the icon once at startup and hand it to the dialog instead.
let cached: NativeImage | null = null;

function iconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "icon.icns")
    : join(app.getAppPath(), "build", "icon.icns");
}

/** Warm the dialog icon. Call once after app ready; failures are non-fatal. */
export function preloadDialogIcon(): void {
  try {
    const img = nativeImage.createFromPath(iconPath());
    cached = img.isEmpty() ? null : img;
  } catch {
    cached = null;
  }
  if (!cached) console.error("[dialog] icon preload failed:", iconPath());
}

/** Preloaded icon, or undefined — undefined lets Electron do its own lookup, so
 *  a bad path degrades to the current behaviour rather than an iconless dialog. */
export function dialogIcon(): NativeImage | undefined {
  return cached ?? undefined;
}
