import {
  getSharedHighlighter,
  registerCustomTheme,
  type DiffsHighlighter,
  type SupportedLanguages,
} from "@pierre/diffs";
import type { ThemeAppearance, ThemeDefinition } from "../themePalette";

import { resolveDiffThemeName } from "./diffRendering";

const highlighterPromiseCache = new Map<string, Promise<DiffsHighlighter>>();
const registeredSyntaxThemes = new Set<string>();

export type SyntaxHighlightTheme = Readonly<{
  name: string;
  appearance: ThemeAppearance;
  foreground: string;
  background: string;
  rules: NonNullable<ThemeDefinition["syntax"]>;
}>;

export function resolveSyntaxHighlightTheme(
  theme: ThemeDefinition | null,
  appearance: ThemeAppearance,
): SyntaxHighlightTheme | null {
  if (!theme) return null;
  const rules = appearance === theme.appearance ? theme.syntax : theme.syntaxVariants?.[appearance];
  const colors = appearance === theme.appearance ? theme.colors : theme.variants?.[appearance];
  if (!rules || !colors) return null;
  const signature = JSON.stringify(rules);
  let hash = 0x811c9dc5;
  for (let index = 0; index < signature.length; index += 1) {
    hash ^= signature.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return {
    name: `t3-${theme.id}-${appearance}-${hash.toString(36)}`,
    appearance,
    foreground: colors.codeForeground,
    background: colors.codeBackground,
    rules,
  };
}

function registerSyntaxHighlightTheme(syntaxTheme: SyntaxHighlightTheme): void {
  if (registeredSyntaxThemes.has(syntaxTheme.name)) return;

  registerCustomTheme(syntaxTheme.name, async () => ({
    name: syntaxTheme.name,
    type: syntaxTheme.appearance,
    fg: syntaxTheme.foreground,
    bg: syntaxTheme.background,
    settings: [
      { settings: { foreground: syntaxTheme.foreground, background: syntaxTheme.background } },
      ...syntaxTheme.rules.map((rule) => {
        const scope = rule.scope;
        return {
          ...(rule.name ? { name: rule.name } : {}),
          ...(scope ? { scope: typeof scope === "string" ? scope : [...scope] } : {}),
          settings: { ...rule.settings },
        };
      }),
    ],
  }));
  registeredSyntaxThemes.add(syntaxTheme.name);
}

/** Registers a custom syntax theme before handing its name to a Pierre surface. */
export function resolveCodeThemeName(
  syntaxTheme: SyntaxHighlightTheme | null,
  appearance: ThemeAppearance,
): string {
  if (!syntaxTheme) return resolveDiffThemeName(appearance);
  registerSyntaxHighlightTheme(syntaxTheme);
  return syntaxTheme.name;
}

export function getSyntaxHighlighterPromise(
  language: string,
  syntaxTheme?: SyntaxHighlightTheme | null,
): Promise<DiffsHighlighter> {
  const cacheKey = `${language}:${syntaxTheme?.name ?? "default"}`;
  const cached = highlighterPromiseCache.get(cacheKey);
  if (cached) return cached;

  if (syntaxTheme) registerSyntaxHighlightTheme(syntaxTheme);

  const promise = getSharedHighlighter({
    themes: syntaxTheme
      ? [syntaxTheme.name]
      : [resolveDiffThemeName("dark"), resolveDiffThemeName("light")],
    langs: [language as SupportedLanguages],
    preferredHighlighter: "shiki-js",
  }).catch((error) => {
    if (language === "text") {
      highlighterPromiseCache.delete(cacheKey);
      // "text" itself failed — Shiki cannot initialize at all, surface the error
      throw error;
    }
    // Language not supported by Shiki — fall back to "text"
    return getSyntaxHighlighterPromise("text", syntaxTheme);
  });
  highlighterPromiseCache.set(cacheKey, promise);
  return promise;
}
