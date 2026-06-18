// Single source of truth for editor language detection.
//
// We lean on Shiki's exhaustive filename→language table (via @pierre/diffs'
// `getFiletypeFromFileName`, the same list the diffs view uses) and map the
// resulting Shiki format to a Monaco language id we can actually tokenize.
// A thin Verne override layer runs first for filename rules and ambiguous
// extensions where Shiki's guess is wrong for us (.m → wolfram, .pl → prolog,
// .svg → text, …) or where Shiki misses our compound filename rules.
//
// Adding a language the editor can render = one SHIKI_TO_MONACO entry (+ a
// grammar/built-in). Anything not mapped falls back to plaintext in the editor
// while diffs still highlight it.

import { getFiletypeFromFileName } from "@pierre/diffs";

/** Monaco language ids that Verne can tokenize, keyed by Shiki format name. */
const SHIKI_TO_MONACO: Record<string, string> = {
  // TextMate grammars (lib/textmate.ts)
  typescript: "typescript",
  tsx: "typescript",
  javascript: "javascript",
  jsx: "javascript",
  vue: "vue",
  astro: "astro",
  svelte: "svelte",
  html: "html",
  css: "tailwindcss",
  scss: "scss",
  less: "less",
  json: "json",
  jsonc: "jsonc",
  markdown: "markdown",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  prisma: "prisma",
  zsh: "shell", // Shiki funnels all shell dialects through `zsh`
  dotenv: "dotenv",
  ini: "ini",
  xml: "xml",
  python: "python",
  rust: "rust",
  go: "go",
  ruby: "ruby",
  php: "php",
  c: "c",
  cpp: "cpp",
  "objective-cpp": "objective-c",
  "objective-c": "objective-c",
  java: "java",
  csharp: "csharp",
  swift: "swift",
  lua: "lua",
  r: "r",
  dart: "dart",
  groovy: "groovy",
  clojure: "clojure",
  fsharp: "fsharp",
  powershell: "powershell",
  pug: "pug",
  handlebars: "handlebars",
  smarty: "smarty",
  tex: "latex",
  latex: "latex",
  sql: "sql",
  makefile: "makefile",
  dockerfile: "dockerfile",
  // Monaco built-in monarch tokenizers (no grammar needed)
  graphql: "graphql",
  kotlin: "kotlin",
  kts: "kotlin",
  scala: "scala",
  elixir: "elixir",
  hcl: "hcl",
  tf: "hcl",
  tfvars: "hcl",
  mdx: "mdx",
  protobuf: "proto",
  solidity: "sol",
  wgsl: "wgsl",
  // Batch 2 grammars
  sass: "sass",
  stylus: "stylus",
  postcss: "postcss",
  json5: "json5",
  hjson: "hjson",
  jsonl: "jsonl",
  mermaid: "mermaid",
  cmake: "cmake",
  nix: "nix",
  zig: "zig",
  haskell: "haskell",
  ocaml: "ocaml",
  elm: "elm",
  gleam: "gleam",
  purescript: "purescript",
  gdscript: "gdscript",
  crystal: "crystal",
  erlang: "erlang",
  v: "v",
  cue: "cue",
  jsonnet: "jsonnet",
  fish: "fish",
  vimscript: "viml",
  erb: "erb",
  blade: "blade",
  haml: "haml",
  glsl: "glsl",
  hlsl: "hlsl",
};

/** Verne-authoritative rules, checked before Shiki. */
function verneOverride(base: string, ext: string): string | null {
  // Compound / extensionless filenames Shiki's ext lookup misses or mis-guesses.
  if (/^\.env(\.|$)/.test(base)) return "dotenv";
  if (/^dockerfile/i.test(base)) return "dockerfile";
  if (base === "Makefile" || base === "makefile" || base === "GNUmakefile") return "makefile";
  if (base === ".swcrc" || base === "jsconfig.json") return "jsonc";
  if (base === "tsconfig.json" || (base.startsWith("tsconfig.") && base.endsWith(".json"))) return "jsonc";
  // Ambiguous extensions where Shiki guesses a language we don't mean.
  switch (ext) {
    case "svg": case "xsl": case "xsd": case "plist": return "xml";
    case "m": case "mm": return "objective-c";
    case "pl": case "pm": return "perl";
    case "h": return "c";
    case "tpl": return "smarty";
  }
  return null;
}

/** Resolve a file path to a Monaco language id (or "plaintext"). */
export function detectMonacoLanguage(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";

  const override = verneOverride(base, ext);
  if (override) return override;

  const fmt = getFiletypeFromFileName(base);
  return SHIKI_TO_MONACO[fmt] ?? "plaintext";
}
