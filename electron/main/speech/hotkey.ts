import type { BrowserWindow } from "electron";

export type DictationMode = "toggle" | "hold";

export type HotkeyConfig = {
  enabled: boolean;
  hotkey: string; // electron accelerator, e.g. "CommandOrControl+E"
  mode: DictationMode;
};

let config: HotkeyConfig = { enabled: false, hotkey: "CommandOrControl+E", mode: "toggle" };

export function setHotkeyConfig(next: Partial<HotkeyConfig>): void {
  config = { ...config, ...next };
}

type KeyState = { key: string; meta: boolean; ctrl: boolean; alt: boolean; shift: boolean };

export function acceleratorMatches(
  accelerator: string,
  k: KeyState,
  platform: NodeJS.Platform,
): boolean {
  const parts = accelerator.split("+").map((p) => p.trim().toLowerCase());
  const wantKey = parts[parts.length - 1];
  const mods = new Set(parts.slice(0, -1));
  const isMac = platform === "darwin";
  const cmdOrCtrl = mods.has("commandorcontrol");
  const wantMeta = (isMac && cmdOrCtrl) || mods.has("cmd") || mods.has("command") || mods.has("meta");
  const wantCtrl = (!isMac && cmdOrCtrl) || mods.has("ctrl") || mods.has("control");
  const wantAlt = mods.has("alt") || mods.has("option");
  const wantShift = mods.has("shift");
  return (
    k.key.toLowerCase() === wantKey &&
    k.meta === wantMeta &&
    k.ctrl === wantCtrl &&
    k.alt === wantAlt &&
    k.shift === wantShift
  );
}

// Registers the before-input-event handler. Toggle mode: preventDefault and
// notify the renderer via the daemon-event bus. Hold mode: let the key through
// so the renderer's keydown/keyup listeners drive press-and-hold (preventDefault
// here would suppress the matching keyup).
export function registerDictationHotkey(win: BrowserWindow): void {
  win.webContents.on("before-input-event", (event, input) => {
    if (!config.enabled) return;
    if (input.type !== "keyDown") return;
    const state: KeyState = {
      key: input.key,
      meta: input.meta,
      ctrl: input.control,
      alt: input.alt,
      shift: input.shift,
    };
    if (!acceleratorMatches(config.hotkey, state, process.platform)) return;
    if (config.mode === "hold") return;
    event.preventDefault();
    if (input.isAutoRepeat) return;
    win.webContents.send("daemon-event", "ui:dictationKeyDown", {});
  });
}
