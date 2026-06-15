import { ref, computed, readonly, watch } from "vue";
import * as monaco from "monaco-editor";
import { invoke, listen } from "@/platform";
import { useRpc } from "./useRpc";
import { useSettings } from "./useSettings";
import type { AppSettings } from "@/types/shared";
import defaultDarkRaw from "@/themes/default-dark.verne.json";
import githubDarkRaw from "@/themes/github-dark.verne.json";
import type { VerneTheme } from "@/types/theme";
import {
  toCssVars,
  toXtermTheme,
  toTextMateRawTheme,
  buildMonacoTheme,
  toVSCodeTheme,
} from "@/lib/themeAdapter";
import { buildMonacoRulesFromColorMap } from "@/lib/themeTokens";
import { setTextMateTheme } from "@/lib/textmate";
import { isMonacoInitialized } from "@/lib/monacoBootstrap";
import { preloadVerneTheme, registerVerneTheme } from "@/lib/diffsTheme";
import { readCachedTheme, writeCachedTheme } from "@/lib/bootstrapCache";

const defaultDark = defaultDarkRaw as unknown as VerneTheme;
const githubDark = githubDarkRaw as unknown as VerneTheme;

const BUNDLED_FALLBACK = "default-dark";
const BUNDLED_THEMES: Record<string, VerneTheme> = {
  "default-dark": defaultDark,
  "github-dark": githubDark,
};

const registry = new Map<string, VerneTheme>();
for (const [key, theme] of Object.entries(BUNDLED_THEMES)) registry.set(key, theme);

const activeThemeName = ref(BUNDLED_FALLBACK);
const availableThemes = ref<string[]>(Object.keys(BUNDLED_THEMES));
const themeTitles = ref<Record<string, string>>(
  Object.fromEntries(Object.entries(BUNDLED_THEMES).map(([k, t]) => [k, t.name])),
);
/** Bumped after every successful applyTheme() — preview/tokenize consumers
 *  watch this instead of activeThemeName to guarantee the TextMate color map
 *  has been updated before they re-render. */
const themeVersion = ref(0);

const darkThemes = computed(() =>
  availableThemes.value.filter((n) => registry.get(n)?.type === "dark"),
);
const lightThemes = computed(() =>
  availableThemes.value.filter((n) => registry.get(n)?.type === "light"),
);

type TerminalThemeUpdater = (theme: Record<string, string>) => void;
let terminalUpdater: TerminalThemeUpdater | null = null;

export function registerTerminalUpdater(fn: TerminalThemeUpdater) {
  terminalUpdater = fn;
}

export function getActiveThemeSpec(): VerneTheme {
  return registry.get(activeThemeName.value) ?? registry.get(BUNDLED_FALLBACK) ?? defaultDark;
}

/** Push the active terminal palette to the daemon so terminal color queries
 *  (OSC 10/11/12, indexed) are answered with the real theme (the grid terminal
 *  emulator otherwise replies with dark defaults). Fire-and-forget. */
function pushTerminalColors(theme: VerneTheme) {
  const t = theme.terminal;
  const a = t.ansi;
  const b = t.ansiBright;
  void invoke("terminal_set_colors", {
    fg: t.foreground,
    bg: t.background,
    cursor: t.cursor,
    ansi: [
      a.black, a.red, a.green, a.yellow, a.blue, a.magenta, a.cyan, a.white,
      b.black, b.red, b.green, b.yellow, b.blue, b.magenta, b.cyan, b.white,
    ],
  }).catch(() => {});
}

function applyUIVars(theme: VerneTheme) {
  const vars = toCssVars(theme.ui);
  const root = document.documentElement;
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  root.setAttribute("data-theme", theme.type);
}

async function applyTheme(name: string) {
  const theme = registry.get(name);
  if (!theme) return;

  applyUIVars(theme);
  terminalUpdater?.(toXtermTheme(theme.terminal));
  pushTerminalColors(theme);
  registerVerneTheme(name, theme);
  preloadVerneTheme(name).catch(() => {});

  activeThemeName.value = name;
  writeCachedTheme({ name, theme });

  // Always update the TextMate registry so previews / code-block tokenizers
  // stay in sync, even when Monaco hasn't booted yet.
  const colorMap = await setTextMateTheme(theme);

  if (isMonacoInitialized()) {
    monaco.editor.defineTheme(
      name,
      buildMonacoTheme(theme, buildMonacoRulesFromColorMap(colorMap)),
    );
    monaco.editor.setTheme(name);
    for (const model of monaco.editor.getModels()) {
      const lang = model.getLanguageId();
      monaco.editor.setModelLanguage(model, "plaintext");
      monaco.editor.setModelLanguage(model, lang);
    }
  }

  themeVersion.value++;
}

function systemPrefersDark(): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/**
 * Pick the theme key to apply given settings + (for "system") OS preference.
 * Fallback order: requested → dark → bundled.
 */
function resolveEffectiveTheme(): string {
  const { settings } = useSettings();
  const s = settings.value;
  const mode: "dark" | "light" =
    s.appearance === "system" ? (systemPrefersDark() ? "dark" : "light") : s.appearance;
  const requested = mode === "light" ? s.lightTheme : s.darkTheme;
  if (requested && registry.has(requested)) return requested;
  if (s.darkTheme && registry.has(s.darkTheme)) return s.darkTheme;
  return BUNDLED_FALLBACK;
}

export function useTheme() {
  async function loadUserThemes() {
    for (const key of registry.keys()) {
      if (!(key in BUNDLED_THEMES)) registry.delete(key);
    }
    themeTitles.value = Object.fromEntries(
      Object.entries(BUNDLED_THEMES).map(([k, t]) => [k, t.name]),
    );
    try {
      const userThemes = await useRpc().request.listUserThemes({});
      for (const ut of userThemes) {
        try {
          const parsed = JSON.parse(ut.json) as VerneTheme;
          registry.set(ut.name, parsed);
          themeTitles.value[ut.name] = parsed.name ?? ut.name;
        } catch {}
      }
    } catch {}
    availableThemes.value = Array.from(registry.keys()).sort();
  }

  async function init() {
    await loadUserThemes();
    await applyTheme(resolveEffectiveTheme());

    const { settings } = useSettings();
    watch(
      () => [settings.value.appearance, settings.value.darkTheme, settings.value.lightTheme],
      () => {
        const next = resolveEffectiveTheme();
        if (next !== activeThemeName.value) applyTheme(next);
      },
    );

    if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
      const mql = window.matchMedia("(prefers-color-scheme: dark)");
      mql.addEventListener("change", () => {
        if (settings.value.appearance !== "system") return;
        const next = resolveEffectiveTheme();
        if (next !== activeThemeName.value) applyTheme(next);
      });
    }

    listen("themes-changed", () => loadUserThemes());
  }

  async function setTheme(name: string) {
    const theme = registry.get(name);
    if (!theme) return;
    const { update, settings } = useSettings();
    const patch: Partial<Pick<AppSettings, "appearance" | "darkTheme" | "lightTheme">> = {};
    if (theme.type === "light") patch.lightTheme = name;
    else patch.darkTheme = name;
    // If the picked theme's type doesn't match what's currently effective,
    // flip `appearance` so the theme actually stays visible (avoids flicker
    // when the settings watcher would otherwise resolve back to the other slot).
    const effectiveMode =
      settings.value.appearance === "system"
        ? systemPrefersDark() ? "dark" : "light"
        : settings.value.appearance;
    if (effectiveMode !== theme.type) patch.appearance = theme.type;
    applyTheme(name);
    await update(patch);
  }

  function previewTheme(name: string) {
    if (registry.has(name)) applyTheme(name);
  }

  return {
    activeThemeName: readonly(activeThemeName),
    availableThemes: readonly(availableThemes),
    darkThemes,
    lightThemes,
    themeTitles: readonly(themeTitles),
    themeVersion: readonly(themeVersion),
    init,
    setTheme,
    previewTheme,
    getActiveThemeSpec,
    /** Exposed for cross-module diff/shiki bridging where VS Code shape is required. */
    getActiveThemeAsVSCode: () => toVSCodeTheme(getActiveThemeSpec()),
  };
}

export function applyCachedThemeSync(): void {
  const cached = readCachedTheme();
  const name = cached?.name ?? BUNDLED_FALLBACK;
  // For bundled themes always prefer the live import — the cached payload is a
  // snapshot from a previous session and goes stale whenever the bundled JSON
  // changes. Caching is only useful for user themes (loaded via async RPC).
  const theme: VerneTheme =
    name in BUNDLED_THEMES
      ? BUNDLED_THEMES[name]
      : ((cached?.theme as VerneTheme | undefined) ?? defaultDark);

  if (!(name in BUNDLED_THEMES)) registry.set(name, theme);
  applyUIVars(theme);
  activeThemeName.value = name;
}
