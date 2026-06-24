import { nativeTheme } from "electron";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DaemonClient } from "../daemon-client";
import { internalDataDir } from "../paths";
import defaultDarkRaw from "../../../src/themes/default-dark.verne.json";
import githubDarkRaw from "../../../src/themes/github-dark.verne.json";

type Ansi = {
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
};

type TerminalTheme = {
  background: string;
  foreground: string;
  cursor: string;
  ansi: Ansi;
  ansiBright: Ansi;
};

type VerneTheme = {
  $schema?: string;
  type?: "dark" | "light";
  terminal?: TerminalTheme;
};

const BUNDLED_THEMES: Record<string, VerneTheme> = {
  "default-dark": defaultDarkRaw as VerneTheme,
  "github-dark": githubDarkRaw as VerneTheme,
};

function loadTheme(name: string | null | undefined): VerneTheme | null {
  if (!name) return null;
  const bundled = BUNDLED_THEMES[name];
  if (bundled) return bundled;
  try {
    const parsed = JSON.parse(
      readFileSync(join(internalDataDir, "themes", `${name}.json`), "utf8"),
    ) as VerneTheme;
    return parsed.$schema === "verne-theme/v1" ? parsed : null;
  } catch {
    return null;
  }
}

function settingString(settings: Record<string, unknown>, key: string): string | null {
  const value = settings[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function resolveTerminalTheme(settings: Record<string, unknown>): TerminalTheme {
  const appearance = settingString(settings, "appearance");
  const mode = appearance === "light" || appearance === "dark"
    ? appearance
    : nativeTheme.shouldUseDarkColors ? "dark" : "light";
  const requested = mode === "light"
    ? settingString(settings, "lightTheme")
    : settingString(settings, "darkTheme");
  return (
    loadTheme(requested)?.terminal
    ?? loadTheme(settingString(settings, "darkTheme"))?.terminal
    ?? BUNDLED_THEMES["default-dark"].terminal
  ) as TerminalTheme;
}

export async function pushTerminalColorsToDaemon(
  daemon: DaemonClient,
  settings: Record<string, unknown>,
): Promise<void> {
  const t = resolveTerminalTheme(settings);
  const a = t.ansi;
  const b = t.ansiBright;
  await daemon.request("terminal_set_colors", {
    fg: t.foreground,
    bg: t.background,
    cursor: t.cursor,
    ansi: [
      a.black,
      a.red,
      a.green,
      a.yellow,
      a.blue,
      a.magenta,
      a.cyan,
      a.white,
      b.black,
      b.red,
      b.green,
      b.yellow,
      b.blue,
      b.magenta,
      b.cyan,
      b.white,
    ],
  });
}
