// Single source of truth for default settings. Electron owns settings.json and
// these defaults; the renderer (useSettings.ts) and the Electron settings store
// (electron/main/native/settings-cmds.ts) both import this — no second copy.
// Rust no longer generates meaningful defaults: the sidecar takes its config
// from Electron's `set_config` push (its AppSettings::default() is now just an
// empty structural fallback). Imported by both the renderer and the Electron
// main bundle, so use a relative type import (no `@` alias in the main build).
import type { AppSettings } from "../types/shared";

export const DEFAULT_SETTINGS: AppSettings = {
  editorTabSize: 2,
  editorInsertSpaces: true,
  autoSave: false,
  editorFontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  editorFontSize: 13,
  editorLineHeight: 0,
  editorWordWrap: false,
  editorLineNumbers: true,
  editorFontLigatures: false,
  editorStickyScroll: false,
  editorMinimap: false,
  editorMinimapRenderCharacters: false,
  editorMinimapScale: 1,
  editorMinimapShowSlider: "mouseover",
  editorMinimapAutohide: false,
  editorMultiCursorModifier: "alt",
  terminalRenderer: "webgl",
  terminalFontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  terminalFontSize: 13,
  terminalLineHeight: 1,
  terminalPadding: 10,
  terminalFontLigatures: false,
  terminalBoldIsBright: false,
  terminalMinimumContrast: 1,
  terminalCursorStyle: "block",
  terminalCursorBlink: false,
  editorFontWeight: "normal",
  terminalFontWeight: "normal",
  terminalFontWeightBold: "bold",
  appearance: "dark",
  darkTheme: "default-dark",
  lightTheme: null,
  filesExclude: { "**/.git": true, "**/.DS_Store": true },
  lspEnabled: false,
  notificationsFocusGate: true,
  notificationsInApp: true,
  notificationsSound: true,
  markdownDefaultView: "preview",
  reviewAgent: "claude",
  voice: {
    enabled: false,
    sttModel: "parakeet-tdt-0.6b-v3-int8",
    dictationMode: "toggle",
    hotkey: "CommandOrControl+E",
    language: "auto",
    confirmBeforeInsert: false,
    dictionaryEnabled: true,
    customTerms: "",
    convertNumbers: true,
  },
};
