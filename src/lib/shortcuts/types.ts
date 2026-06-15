// src/lib/shortcuts/types.ts
// Shared between the Electron main process (menu accelerators) and the renderer
// (keydown matching + the shortcuts modal). Keep this module pure — no Vue/DOM
// imports — so it bundles cleanly into both bundles.

export type ShortcutCategory =
  | "General"
  | "File"
  | "Edit"
  | "View"
  | "Navigation"
  | "Terminal"
  | "Window";

// Where the chord is primarily handled. Descriptive metadata only — NOT a hard
// filter. App.vue decides which names to match in keydown.
export type ShortcutTarget = "menu" | "renderer";

// A catalog entry: the in-code default definition of a shortcut.
export interface ShortcutDef {
  name: string;            // stable unique id, e.g. "command-palette"
  label: string;           // human label for the modal
  category: ShortcutCategory;
  defaultBinding: string;  // normalized binding, e.g. "Mod+Shift+P"
  target: ShortcutTarget;
}

// An effective shortcut: catalog entry with the user override (if any) applied
// (defaultBinding replaced by the resolved binding).
export interface Shortcut extends Omit<ShortcutDef, "defaultBinding"> {
  binding: string;
}
