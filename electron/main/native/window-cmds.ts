import { screen } from "electron";
import { registerNative } from "../ipc-router";

export function registerWindowCommands(): void {
  registerNative("toggle_maximize", (_p, win) => {
    if (win.isMaximized()) win.unmaximize(); else win.maximize();
    return win.isMaximized();
  });

  // Manual window-drag fallback. Title-bar drag regions nested inside reka-ui's
  // resizable panels lose their native `-webkit-app-region: drag` (the panels'
  // `overflow: hidden` clip drops it). `useWindowDrag` calls these on mousedown /
  // mouseup over an empty drag area; main follows the cursor in between.
  let dragTimer: ReturnType<typeof setInterval> | null = null;
  const stopDrag = () => {
    if (dragTimer) { clearInterval(dragTimer); dragTimer = null; }
  };
  registerNative("window_drag_start", (_p, win) => {
    stopDrag();
    const cursor = screen.getCursorScreenPoint();
    const [wx, wy] = win.getPosition();
    const offX = cursor.x - wx;
    const offY = cursor.y - wy;
    dragTimer = setInterval(() => {
      if (win.isDestroyed()) return stopDrag();
      const c = screen.getCursorScreenPoint();
      win.setPosition(c.x - offX, c.y - offY);
    }, 8);
    return true;
  });
  registerNative("window_drag_end", () => {
    stopDrag();
    return true;
  });

  // macOS screen refresh rate; Electron exposes displayFrequency on Display.
  registerNative("get_window_max_fps", () => {
    const d = screen.getPrimaryDisplay() as Electron.Display & { displayFrequency?: number };
    return Math.round(d.displayFrequency && d.displayFrequency > 0 ? d.displayFrequency : 60);
  });
}
