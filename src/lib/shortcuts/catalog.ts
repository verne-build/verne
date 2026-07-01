// src/lib/shortcuts/catalog.ts
// Source of truth for keyboard shortcuts. Pure data — imported by both the
// Electron main process (menu accelerators) and the renderer (keydown + modal).
//
// `name` is the stable id used by the override file and by lookups everywhere.
// Bindings sourced from electron/main/menu.ts and src/App.vue handleGlobalKeydown.
import type { ShortcutDef } from "./types";

export const SHORTCUT_CATALOG: ShortcutDef[] = [
  // General
  { name: "settings", label: "Settings", category: "General", defaultBinding: "Mod+,", target: "menu" },
  { name: "shortcuts-help", label: "Keyboard Shortcuts", category: "General", defaultBinding: "Mod+Shift+/", target: "renderer" },

  // File
  { name: "open-workspace", label: "Open Workspace", category: "File", defaultBinding: "Mod+O", target: "menu" },
  { name: "new-terminal", label: "New Terminal", category: "File", defaultBinding: "Mod+T", target: "menu" },
  { name: "new-agent-terminal", label: "New Agent Terminal", category: "File", defaultBinding: "Mod+Alt+T", target: "menu" },
  { name: "new-file", label: "New File", category: "File", defaultBinding: "Mod+N", target: "menu" },
  { name: "close-tab", label: "Close Tab", category: "File", defaultBinding: "Mod+W", target: "menu" },

  // Edit
  { name: "undo", label: "Undo", category: "Edit", defaultBinding: "Mod+Z", target: "menu" },
  { name: "redo", label: "Redo", category: "Edit", defaultBinding: "Mod+Shift+Z", target: "menu" },
  { name: "select-all", label: "Select All", category: "Edit", defaultBinding: "Mod+A", target: "menu" },

  // View
  { name: "toggle-left-panel", label: "Toggle Left Panel", category: "View", defaultBinding: "Mod+B", target: "menu" },
  { name: "toggle-right-panel", label: "Toggle Right Panel", category: "View", defaultBinding: "Mod+Alt+B", target: "menu" },
  { name: "focus-file-explorer", label: "Focus File Explorer", category: "View", defaultBinding: "Mod+Shift+E", target: "menu" },
  { name: "focus-source-control", label: "Focus Source Control", category: "View", defaultBinding: "Ctrl+Shift+G", target: "menu" },

  // Navigation
  { name: "command-palette", label: "Command Palette", category: "Navigation", defaultBinding: "Mod+K", target: "menu" },
  { name: "go-to-file", label: "Go to File", category: "Navigation", defaultBinding: "Mod+P", target: "menu" },
  { name: "run-action", label: "Run Action", category: "Navigation", defaultBinding: "Mod+Shift+P", target: "menu" },
  { name: "next-tab", label: "Next Tab", category: "Navigation", defaultBinding: "Mod+Shift+]", target: "menu" },
  { name: "prev-tab", label: "Previous Tab", category: "Navigation", defaultBinding: "Mod+Shift+[", target: "menu" },
  { name: "reopen-closed-tab", label: "Reopen Closed Tab", category: "Navigation", defaultBinding: "Mod+Shift+T", target: "menu" },
  // Parametric range — match logic stays hardcoded in App.vue for v1 (display only here).
  { name: "jump-to-tab", label: "Jump to Tab 1–9", category: "Navigation", defaultBinding: "Cmd+1", target: "renderer" },

  // Terminal
  { name: "focus-terminal", label: "Focus Terminal", category: "Terminal", defaultBinding: "Ctrl+`", target: "menu" },
  // Split bindings are Cmd-only (literal) to preserve "only when a terminal owns
  // focus and never on Ctrl+D (EOF)" — see App.vue.
  { name: "split-pane-h", label: "Split Pane Horizontally", category: "Terminal", defaultBinding: "Cmd+D", target: "renderer" },
  { name: "split-pane-v", label: "Split Pane Vertically", category: "Terminal", defaultBinding: "Cmd+Shift+D", target: "renderer" },

  // Window
  { name: "close-window", label: "Close Window", category: "Window", defaultBinding: "Mod+Shift+W", target: "menu" },
  { name: "inspect-element", label: "Inspect Element", category: "Window", defaultBinding: "Mod+Alt+I", target: "menu" },
];
