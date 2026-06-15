// Post-processing dictionary for dictation: rewrites spoken phrases into proper
// developer terms on the final transcript before insertion (model-agnostic).
// Matching is case-insensitive, word-boundary aware, and whitespace-flexible so
// "next js" / "next  js" both become "Next.js". Rules are applied in order, so
// list multi-word / more-specific rules before single words.

export interface DictationRule {
  /** Spoken form, lowercase. Spaces match any run of whitespace. */
  spoken: string;
  /** Replacement text inserted verbatim (preserves casing/punctuation). */
  replacement: string;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compile(rule: DictationRule): RegExp | null {
  const tokens = rule.spoken.trim().split(/\s+/).filter(Boolean).map(escapeRegex);
  if (!tokens.length) return null;
  return new RegExp(`\\b${tokens.join("\\s+")}\\b`, "gi");
}

export function applyDictationDictionary(text: string, rules: DictationRule[]): string {
  let out = text;
  for (const rule of rules) {
    const re = compile(rule);
    if (re) out = out.replace(re, rule.replacement);
  }
  return out;
}

// Parse a user-supplied list. One rule per line: "spoken => Replacement".
// Blank lines and lines starting with # are ignored.
export function parseCustomRules(text: string): DictationRule[] {
  if (!text) return [];
  const rules: DictationRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=>");
    if (idx === -1) continue;
    const spoken = line.slice(0, idx).trim().toLowerCase();
    const replacement = line.slice(idx + 2).trim();
    if (spoken && replacement) rules.push({ spoken, replacement });
  }
  return rules;
}

// Curated defaults. Multi-word / "dot" variants first so they win over the
// single-word capitalization rules below them.
export const DEFAULT_DICTATION_RULES: DictationRule[] = [
  // Frameworks / runtimes (with spoken-out "dot" + concatenated variants)
  { spoken: "next dot j s", replacement: "Next.js" },
  { spoken: "next dot js", replacement: "Next.js" },
  { spoken: "next j s", replacement: "Next.js" },
  { spoken: "next js", replacement: "Next.js" },
  { spoken: "nextjs", replacement: "Next.js" },
  { spoken: "nuxt j s", replacement: "Nuxt.js" },
  { spoken: "nuxt js", replacement: "Nuxt.js" },
  { spoken: "node dot j s", replacement: "Node.js" },
  { spoken: "node dot js", replacement: "Node.js" },
  { spoken: "node j s", replacement: "Node.js" },
  { spoken: "node js", replacement: "Node.js" },
  { spoken: "nodejs", replacement: "Node.js" },
  { spoken: "vue dot j s", replacement: "Vue.js" },
  { spoken: "vue dot js", replacement: "Vue.js" },
  { spoken: "vue j s", replacement: "Vue.js" },
  { spoken: "vue js", replacement: "Vue.js" },
  { spoken: "view dot j s", replacement: "Vue.js" },
  { spoken: "view dot js", replacement: "Vue.js" },
  { spoken: "view j s", replacement: "Vue.js" },
  { spoken: "view js", replacement: "Vue.js" },
  { spoken: "three dot j s", replacement: "Three.js" },
  { spoken: "three dot js", replacement: "Three.js" },
  { spoken: "three j s", replacement: "Three.js" },
  { spoken: "three js", replacement: "Three.js" },
  { spoken: "express j s", replacement: "Express" },
  { spoken: "express js", replacement: "Express" },
  { spoken: "svelte kit", replacement: "SvelteKit" },
  { spoken: "svelte", replacement: "Svelte" },
  { spoken: "astro", replacement: "Astro" },
  { spoken: "solid j s", replacement: "SolidJS" },
  { spoken: "solid js", replacement: "SolidJS" },
  { spoken: "angular", replacement: "Angular" },
  { spoken: "preact", replacement: "Preact" },
  { spoken: "nest j s", replacement: "NestJS" },
  { spoken: "nest js", replacement: "NestJS" },
  { spoken: "nestjs", replacement: "NestJS" },
  { spoken: "fastify", replacement: "Fastify" },
  { spoken: "hono", replacement: "Hono" },
  { spoken: "vite press", replacement: "VitePress" },
  { spoken: "vitepress", replacement: "VitePress" },
  { spoken: "storybook", replacement: "Storybook" },
  { spoken: "playwright", replacement: "Playwright" },
  { spoken: "vitest", replacement: "Vitest" },
  { spoken: "cypress", replacement: "Cypress" },
  { spoken: "ruby on rails", replacement: "Ruby on Rails" },
  { spoken: "laravel", replacement: "Laravel" },
  { spoken: "word press", replacement: "WordPress" },
  { spoken: "wordpress", replacement: "WordPress" },
  { spoken: "django", replacement: "Django" },
  { spoken: "flask", replacement: "Flask" },
  { spoken: "fast api", replacement: "FastAPI" },
  { spoken: "fastapi", replacement: "FastAPI" },
  { spoken: "symfony", replacement: "Symfony" },
  { spoken: "asp dot net", replacement: "ASP.NET" },
  { spoken: "dot net", replacement: ".NET" },
  { spoken: "type script", replacement: "TypeScript" },
  { spoken: "typescript", replacement: "TypeScript" },
  { spoken: "t s", replacement: "TS" },
  { spoken: "java script", replacement: "JavaScript" },
  { spoken: "javascript", replacement: "JavaScript" },
  { spoken: "j s", replacement: "JS" },
  { spoken: "ruby", replacement: "Ruby" },
  { spoken: "python", replacement: "Python" },
  { spoken: "go lang", replacement: "Go" },
  { spoken: "golang", replacement: "Go" },
  { spoken: "php", replacement: "PHP" },
  { spoken: "c sharp", replacement: "C#" },
  { spoken: "c plus plus", replacement: "C++" },
  { spoken: "objective c", replacement: "Objective-C" },
  { spoken: "kotlin", replacement: "Kotlin" },
  { spoken: "elixir", replacement: "Elixir" },
  { spoken: "c s s", replacement: "CSS" },
  { spoken: "tailwind css", replacement: "Tailwind CSS" },
  { spoken: "tailwind", replacement: "Tailwind" },
  { spoken: "web view", replacement: "webview" },
  { spoken: "git hub", replacement: "GitHub" },
  { spoken: "github", replacement: "GitHub" },
  { spoken: "git lab", replacement: "GitLab" },
  { spoken: "mongo db", replacement: "MongoDB" },
  { spoken: "postgres", replacement: "Postgres" },
  { spoken: "graphql", replacement: "GraphQL" },
  { spoken: "vue", replacement: "Vue" },
  { spoken: "react", replacement: "React" },
  { spoken: "electron", replacement: "Electron" },
  { spoken: "vite", replacement: "Vite" },
  // Acronyms / casing
  { spoken: "rest api", replacement: "REST API" },
  { spoken: "json", replacement: "JSON" },
  { spoken: "yaml", replacement: "YAML" },
  { spoken: "html", replacement: "HTML" },
  { spoken: "css", replacement: "CSS" },
  { spoken: "api", replacement: "API" },
  { spoken: "cli", replacement: "CLI" },
  { spoken: "url", replacement: "URL" },
  { spoken: "ui", replacement: "UI" },
  { spoken: "sql", replacement: "SQL" },
  { spoken: "npm", replacement: "npm" },
  { spoken: "pnpm", replacement: "pnpm" },
  // Storage / time units
  { spoken: "kilobytes", replacement: "KB" },
  { spoken: "kilobyte", replacement: "KB" },
  { spoken: "megabytes", replacement: "MB" },
  { spoken: "megabyte", replacement: "MB" },
  { spoken: "gigabytes", replacement: "GB" },
  { spoken: "gigabyte", replacement: "GB" },
  { spoken: "terabytes", replacement: "TB" },
  { spoken: "terabyte", replacement: "TB" },
  { spoken: "milliseconds", replacement: "ms" },
  { spoken: "millisecond", replacement: "ms" },
];

// Build the active rule set: user rules first (highest priority), then defaults.
export function buildDictationRules(
  customTerms: string | undefined,
  includeDefaults = true,
): DictationRule[] {
  const custom = parseCustomRules(customTerms ?? "");
  return includeDefaults ? [...custom, ...DEFAULT_DICTATION_RULES] : custom;
}
