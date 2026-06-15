import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { internalDataDir } from "../paths";
import { registerNative } from "../ipc-router";
import type { DaemonClient } from "../daemon-client";
// Electron owns the default settings — single source shared with the renderer.
import { DEFAULT_SETTINGS } from "../../../src/lib/defaultSettings";

type Settings = Record<string, unknown>;

/** Mirror of Rust load_from_disk legacy migration. Mutates a parsed object. */
function migrate(obj: Settings): Settings {
  for (const k of ["dangerouslySkipPermissions", "autoApproveByDefault", "uiMode", "defaultFormatter", "formatOnSave", "aiProvider", "openaiApiKey", "githubCopilotToken"]) {
    delete obj[k];
  }
  if (!("appearance" in obj)) {
    const legacy = typeof obj.theme === "string" ? (obj.theme as string) : undefined;
    obj.appearance = "dark";
    obj.darkTheme = !legacy || legacy === "sovngarde" ? "default-dark" : legacy;
    obj.lightTheme = null;
  }
  delete obj.theme;
  return obj;
}

export function makeSettingsStore(filePath: string) {
  function rawFile(): Settings {
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
      return parsed && typeof parsed === "object" ? migrate(parsed as Settings) : {};
    } catch {
      return {};
    }
  }
  function persist(s: Settings): void {
    mkdirSync(dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(s, null, 2));
    renameSync(tmp, filePath);
  }
  return {
    path(): string {
      if (!existsSync(filePath)) {
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, "{}\n");
      }
      return filePath;
    },
    read(): Settings {
      return { ...structuredClone(DEFAULT_SETTINGS), ...rawFile() };
    },
    update(partial: Settings): Settings {
      const next = this.read();
      for (const [k, v] of Object.entries(partial)) {
        if (v === null) delete next[k];
        else next[k] = v;
      }
      persist(next);
      return next;
    },
  };
}

function listThemes(themesDir: string): Array<{ name: string; json: string }> {
  let entries: string[];
  try {
    entries = readdirSync(themesDir);
  } catch {
    return [];
  }
  const out: Array<{ name: string; json: string }> = [];
  for (const f of entries) {
    if (!f.endsWith(".json")) continue;
    try {
      const json = readFileSync(join(themesDir, f), "utf8");
      const parsed = JSON.parse(json) as { $schema?: string };
      if (parsed.$schema === "verne-theme/v1") out.push({ name: f.slice(0, -5), json });
    } catch { /* skip bad file */ }
  }
  return out;
}

export function registerSettingsCommands(sidecar: DaemonClient): void {
  const filePath = join(internalDataDir, "settings.json");
  const themesDir = join(internalDataDir, "themes");
  const store = makeSettingsStore(filePath);

  registerNative("get_settings", () => store.read());
  registerNative("get_settings_path", () => store.path());
  registerNative("list_user_themes", () => listThemes(themesDir));
  registerNative("update_settings", async (p: { settings: Settings }, win) => {
    const next = store.update(p.settings ?? {});
    // Push to the sidecar (it consumes filesExclude / worktreesRoot internally),
    // then notify the renderer.
    try { await sidecar.request("set_config", { settings: next }); } catch (e) { console.error("[settings] set_config push failed:", e); }
    win?.webContents.send("daemon-event", "settings-changed", next);
    return next;
  });
}

/** Read current settings (for the startup push). */
export function currentSettings(): Settings {
  return makeSettingsStore(join(internalDataDir, "settings.json")).read();
}
