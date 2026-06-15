// Verne theme schema (v1).
//
// One theme file = one mode (dark or light). Variants ship as separate files.
//
// Sections:
//   ui      — shadcn CSS variable values (keys without leading `--`).
//   editor  — Monaco editor chrome colors (VS Code `colors` keyspace).
//   terminal — xterm.js palette (16 ANSI + background/foreground/cursor).
//   syntax  — TextMate-scope-selector rules. Adapter converts to vscode-textmate
//             IRawTheme verbatim — round-trip identical color map vs equivalent
//             VS Code theme.
//
// Schema URI ("$schema") is informational; not validated at runtime.

export type VerneThemeType = "dark" | "light";

export interface VerneSyntaxRule {
  /** TextMate scope selector(s). Omit for the default fallback rule. */
  scope?: string | string[];
  /** Descriptive only (kept for VS Code round-trip). */
  name?: string;
  color?: string;
  bg?: string;
  italic?: boolean;
  bold?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
}

export interface VerneAnsiPalette {
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
}

export interface VerneThemeTerminal {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
  ansi: VerneAnsiPalette;
  ansiBright: VerneAnsiPalette;
}

export interface VerneTheme {
  $schema?: string;
  name: string;
  type: VerneThemeType;
  ui: Record<string, string>;
  editor: Record<string, string>;
  terminal: VerneThemeTerminal;
  syntax: VerneSyntaxRule[];
}
