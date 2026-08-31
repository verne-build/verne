import { useMemo } from "react";

import { resolveCodeThemeName, resolveSyntaxHighlightTheme } from "../lib/syntaxHighlighting";
import { getAppliedThemeDefinition, resolveThemeHalf } from "../themePalette";
import { useTheme } from "./useTheme";

/** The active app theme plus the registered theme name consumed by code renderers. */
export function useCodeTheme() {
  const themeState = useTheme();
  const { resolvedTheme, theme, themeHalves } = themeState;
  const syntaxTheme = useMemo(
    () =>
      resolveSyntaxHighlightTheme(
        getAppliedThemeDefinition(resolveThemeHalf(theme, themeHalves, resolvedTheme)),
        resolvedTheme,
      ),
    [resolvedTheme, theme, themeHalves],
  );
  const codeThemeName = useMemo(
    () => resolveCodeThemeName(syntaxTheme, resolvedTheme),
    [resolvedTheme, syntaxTheme],
  );

  return { ...themeState, codeThemeName, syntaxTheme } as const;
}
