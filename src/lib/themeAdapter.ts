// VerneTheme → engine-specific shapes. Pure functions, no side effects.

import type * as monaco from "monaco-editor";
import type { IRawTheme } from "vscode-textmate";
import type {
  VerneTheme,
  VerneThemeTerminal,
  VerneSyntaxRule,
} from "@/types/theme";

export function toCssVars(ui: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(ui)) {
    if (typeof v === "string") out[`--${k}`] = v;
  }
  return out;
}

export function toMonacoColors(editor: Record<string, string>): monaco.editor.IColors {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(editor)) {
    if (typeof v === "string") out[k] = v;
  }
  return out as monaco.editor.IColors;
}

export function toXtermTheme(t: VerneThemeTerminal): Record<string, string> {
  return {
    background: t.background,
    foreground: t.foreground,
    cursor: t.cursor,
    selectionBackground: t.selectionBackground,
    black: t.ansi.black,
    red: t.ansi.red,
    green: t.ansi.green,
    yellow: t.ansi.yellow,
    blue: t.ansi.blue,
    magenta: t.ansi.magenta,
    cyan: t.ansi.cyan,
    white: t.ansi.white,
    brightBlack: t.ansiBright.black,
    brightRed: t.ansiBright.red,
    brightGreen: t.ansiBright.green,
    brightYellow: t.ansiBright.yellow,
    brightBlue: t.ansiBright.blue,
    brightMagenta: t.ansiBright.magenta,
    brightCyan: t.ansiBright.cyan,
    brightWhite: t.ansiBright.white,
  };
}

function joinFontStyle(rule: VerneSyntaxRule): string | undefined {
  const parts: string[] = [];
  if (rule.italic) parts.push("italic");
  if (rule.bold) parts.push("bold");
  if (rule.underline) parts.push("underline");
  if (rule.strikethrough) parts.push("strikethrough");
  return parts.length ? parts.join(" ") : undefined;
}

export function toTextMateRawTheme(theme: VerneTheme): IRawTheme {
  // The leading no-scope entry is vscode-textmate's "default" foreground/background —
  // mirrors what VS Code's runtime does when it wraps `colors["editor.foreground"]`.
  const settings: any[] = [
    {
      settings: {
        foreground: theme.editor.foreground ?? "#f2fffc",
        background: theme.editor.background ?? "#0d1016",
      },
    },
  ];
  for (const rule of theme.syntax) {
    const entry: any = { settings: {} };
    if (rule.scope !== undefined) entry.scope = rule.scope;
    if (rule.name) entry.name = rule.name;
    if (rule.color) entry.settings.foreground = rule.color;
    if (rule.bg) entry.settings.background = rule.bg;
    const fs = joinFontStyle(rule);
    if (fs) entry.settings.fontStyle = fs;
    settings.push(entry);
  }
  return { name: theme.name, settings };
}

export function buildMonacoTheme(
  theme: VerneTheme,
  colorMapRules: monaco.editor.ITokenThemeRule[],
): monaco.editor.IStandaloneThemeData {
  return {
    base: theme.type === "light" ? "vs" : "vs-dark",
    inherit: false,
    rules: colorMapRules,
    colors: toMonacoColors(theme.editor),
  };
}

/**
 * Parse a VS Code-style `fontStyle` string ("italic bold underline strikethrough")
 * into the booleans Verne uses. Helper for VS Code theme imports.
 */
export function parseFontStyle(fs: string | undefined): {
  italic?: boolean;
  bold?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
} {
  if (!fs) return {};
  const parts = fs.split(/\s+/);
  const out: ReturnType<typeof parseFontStyle> = {};
  if (parts.includes("italic")) out.italic = true;
  if (parts.includes("bold")) out.bold = true;
  if (parts.includes("underline")) out.underline = true;
  if (parts.includes("strikethrough")) out.strikethrough = true;
  return out;
}

/**
 * Convert a single VS Code tokenColor entry to a Verne syntax rule.
 * Lossless for the fields Verne models (foreground, background, fontStyle, scope).
 */
export function fromVSCodeTokenColor(tc: {
  name?: string;
  scope?: string | string[];
  settings?: { foreground?: string; background?: string; fontStyle?: string };
}): VerneSyntaxRule {
  const rule: VerneSyntaxRule = {};
  if (tc.scope !== undefined) rule.scope = tc.scope;
  if (tc.name) rule.name = tc.name;
  const s = tc.settings ?? {};
  if (s.foreground) rule.color = s.foreground;
  if (s.background) rule.bg = s.background;
  Object.assign(rule, parseFontStyle(s.fontStyle));
  return rule;
}

/**
 * VerneTheme → VS Code-shaped theme. Shiki / @pierre/diffs accept this format
 * natively, so the diff highlighter calls this before registering with Shiki.
 */
export function toVSCodeTheme(theme: VerneTheme): {
  name: string;
  type: "dark" | "light";
  colors: Record<string, string>;
  tokenColors: Array<{ name?: string; scope?: string | string[]; settings: Record<string, string> }>;
} {
  const tokenColors = theme.syntax.map((rule) => {
    const settings: Record<string, string> = {};
    if (rule.color) settings.foreground = rule.color;
    if (rule.bg) settings.background = rule.bg;
    const fs = joinFontStyle(rule);
    if (fs) settings.fontStyle = fs;
    const entry: any = { settings };
    if (rule.scope !== undefined) entry.scope = rule.scope;
    if (rule.name) entry.name = rule.name;
    return entry;
  });
  return {
    name: theme.name,
    type: theme.type,
    colors: { ...theme.editor },
    tokenColors,
  };
}
