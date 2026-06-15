// Bridge Verne themes to @pierre/diffs (Shiki).
//
// Shiki accepts VS Code-shaped themes natively, so we convert VerneTheme →
// VS Code shape via the adapter before registering. Same pattern as Shiki's
// `loadTheme` (https://shiki.style/guide/load-theme).

import { preloadHighlighter, registerCustomTheme } from "@pierre/diffs";
import type { VerneTheme } from "@/types/theme";
import { toVSCodeTheme } from "./themeAdapter";

const registered = new Set<string>();

/**
 * Register a Verne theme with @pierre/diffs under the given name.
 * Idempotent — pierre errors on re-registration; guarded here.
 *
 * NB: pierre's `attachResolvedThemes` stores the resolved theme under
 * `theme.name`, not the registration key. So we override `name` in the
 * loaded spec to match the registration key.
 */
export function registerVerneTheme(name: string, spec: VerneTheme): void {
  if (registered.has(name)) return;
  registered.add(name);
  const vscodeShape = toVSCodeTheme(spec);
  registerCustomTheme(name, async () => ({ ...vscodeShape, name }));
}

/**
 * Pre-resolve a registered theme so the highlighter is warm before any
 * DiffView render. Safe to call multiple times.
 */
export async function preloadVerneTheme(name: string): Promise<void> {
  await preloadHighlighter({
    themes: [name as any],
    langs: [],
  });
}
