// electron/main/native/shortcuts-cmds.ts
// Keyboard shortcut registry — Electron-main owned, mirroring settings-cmds.ts.
// Catalog defaults (in code) merged over a user JSON at internalDataDir/shortcuts.json.
import { readFileSync, writeFileSync, mkdirSync, existsSync, watch, type FSWatcher } from "node:fs";
import { join, dirname } from "node:path";
import type { BrowserWindow } from "electron";
import { internalDataDir } from "../paths";
import { registerNative } from "../ipc-router";
import { SHORTCUT_CATALOG } from "../../../src/lib/shortcuts/catalog";
import { toElectronAccelerator } from "../../../src/lib/shortcuts/binding";
import type { Shortcut } from "../../../src/lib/shortcuts/types";

function sanitizeOverrides(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
  }
  return out;
}

function mergeCatalog(overrides: Record<string, string>): Shortcut[] {
  return SHORTCUT_CATALOG.map((d) => ({
    name: d.name,
    label: d.label,
    category: d.category,
    target: d.target,
    binding: overrides[d.name] ?? d.defaultBinding,
  }));
}

export function makeShortcutsStore(filePath: string) {
  let cache: Shortcut[] | null = null;

  function load(): Shortcut[] {
    let raw: unknown = {};
    if (existsSync(filePath)) {
      try {
        raw = JSON.parse(readFileSync(filePath, "utf8"));
      } catch (e) {
        console.warn("[shortcuts] invalid JSON; keeping last-good:", e);
        if (cache) return cache;
        raw = {};
      }
    }
    cache = mergeCatalog(sanitizeOverrides(raw));
    return cache;
  }

  return {
    read(): Shortcut[] {
      return cache ?? load();
    },
    load,
    accel(name: string): string {
      const s = this.read().find((x) => x.name === name);
      return s ? toElectronAccelerator(s.binding) : "";
    },
    path(): string {
      if (!existsSync(filePath)) {
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, "{}\n");
      }
      return filePath;
    },
  };
}

// Module singleton used by menu.ts (accel) and the registered handlers.
let store: ReturnType<typeof makeShortcutsStore> | null = null;
function ensureStore() {
  return (store ??= makeShortcutsStore(join(internalDataDir, "shortcuts.json")));
}

/** Electron accelerator string for a shortcut name (for menu.ts). */
export function accel(name: string): string {
  return ensureStore().accel(name);
}

let watcher: FSWatcher | null = null;
let debounce: NodeJS.Timeout | null = null;

/**
 * Registers get_shortcuts / get_shortcuts_path and starts the real-time watcher.
 * onRegistryChanged is invoked (debounced) after a reload so the caller can
 * rebuild the native menu; the renderer is notified via `shortcuts-changed`.
 */
export function registerShortcutsCommands(
  getWindow: () => BrowserWindow,
  onRegistryChanged: () => void,
): void {
  const s = ensureStore();
  s.load();

  registerNative("get_shortcuts", () => s.read());
  registerNative("get_shortcuts_path", () => s.path());

  mkdirSync(internalDataDir, { recursive: true });
  watcher = watch(internalDataDir, (_evt, filename) => {
    if (filename !== "shortcuts.json") return;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      s.load();
      try { onRegistryChanged(); } catch (e) { console.error("[shortcuts] menu rebuild failed:", e); }
      try { getWindow().webContents.send("daemon-event", "shortcuts-changed"); } catch { /* window gone */ }
    }, 150);
  });
}

export function stopShortcutsWatcher(): void {
  if (debounce) { clearTimeout(debounce); debounce = null; }
  watcher?.close();
  watcher = null;
}
