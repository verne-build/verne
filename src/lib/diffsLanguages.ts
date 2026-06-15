// Bridge Verne's CUSTOM injection grammars to @pierre/diffs (Shiki).
//
// For primary languages (vue, ts, css, etc.) we use Shiki's bundled grammars —
// they originate from the same VS Code source as the files in src/
// grammars/, so duplicating the registration buys nothing.
//
// What Shiki DOESN'T ship: Verne's custom injection grammars for Tailwind
// (`@apply`, `@layer`, `theme()`), lit-html (HTML/CSS inside template
// literals), and JSDoc as a separate scope. We register only those, with
// `injectTo` so Shiki attaches them to the right host scopes.
//
// CodeEditor uses these same grammars via vscode-textmate (lib/textmate.ts),
// so pierre and Monaco share a source of truth for the custom bits while
// trusting Shiki/VS Code for the standard languages.

import { registerCustomLanguage } from "@pierre/diffs";
import { loadGrammarSource } from "./textmate";

interface InjectionEntry {
  /** TextMate scope name (also the file basename in src/grammars/). */
  scope: string;
  /** Host scopes to inject into. */
  injectTo: string[];
}

const INJECTIONS: InjectionEntry[] = [
  { scope: "vue.directives", injectTo: ["text.html.vue", "text.html.derivative", "text.html.basic"] },
  { scope: "source.jsdoc.ts", injectTo: ["source.ts", "source.tsx"] },
  { scope: "source.jsdoc.js", injectTo: ["source.js", "source.js.jsx"] },
  { scope: "tailwindcss.at-rules.injection", injectTo: ["source.css", "source.css.tailwind"] },
  { scope: "tailwindcss.at-apply.injection", injectTo: ["source.css", "source.css.tailwind"] },
  { scope: "tailwindcss.theme-fn.injection", injectTo: ["source.css", "source.css.tailwind"] },
  { scope: "inline.lit-html", injectTo: ["source.ts", "source.tsx", "source.js", "source.js.jsx"] },
  { scope: "inline.lit-html.string.injection", injectTo: ["source.ts", "source.tsx", "source.js", "source.js.jsx"] },
  { scope: "inline.lit-html.style.injection", injectTo: ["source.ts", "source.tsx", "source.js", "source.js.jsx"] },
];

let registered = false;

/**
 * Register Verne's custom injection grammars with @pierre/diffs.
 * Returns the list of registered language ids so the caller can pass them
 * to `preloadHighlighter({ langs })` — that ensures the injections are
 * attached to the highlighter at startup, so Shiki applies them when later
 * loading the host language (vue, css, ts, ...).
 *
 * Idempotent — subsequent calls are no-ops and return the same list.
 */
export function registerVerneInjectionsWithPierre(): string[] {
  const ids = INJECTIONS.map((i) => i.scope);
  if (registered) return ids;
  registered = true;
  for (const inj of INJECTIONS) {
    // Cast: vscode-textmate's IRawGrammar and Shiki's IRawGrammar are
    // structurally identical but live in separate type packages — TS sees
    // them as unrelated due to private __brand symbols. Runtime fine.
    registerCustomLanguage(
      inj.scope,
      (async () => {
        const raw = await loadGrammarSource(inj.scope);
        if (!raw) throw new Error(`Missing injection grammar for ${inj.scope}`);
        return {
          default: [
            {
              ...raw,
              name: inj.scope,
              scopeName: inj.scope,
              injectTo: inj.injectTo,
            },
          ],
        };
      }) as any,
      [],
    );
  }
  return ids;
}
