/**
 * TextMate grammar -> Monaco tokenizer bridge.
 * Keep grammar loading lazy so app startup doesn't parse every grammar upfront.
 */
import { Registry, parseRawGrammar, INITIAL, type IRawGrammar, type StateStack } from "vscode-textmate";
import { loadWASM, createOnigScanner, createOnigString } from "vscode-oniguruma";
import * as monaco from "monaco-editor";
import defaultDarkRaw from "../themes/default-dark.verne.json";
import type { VerneTheme } from "@/types/theme";
import { toTextMateRawTheme } from "./themeAdapter";
import {
  setActiveColorMap,
  metadataToTokenName,
  resolveColorFromMetadata,
  resolveFontStyleFromMetadata,
} from "./themeTokens";
import { MAX_SAFE_TOKENIZATION_LINE_LENGTH } from "./editorLargeFile";

const defaultDark = defaultDarkRaw as unknown as VerneTheme;

type GrammarLoader = () => Promise<IRawGrammar>;

const rawGrammarModules = import.meta.glob("../grammars/*", {
  query: "?raw",
  import: "default",
}) as Record<string, () => Promise<string>>;

function loadRawGrammar(path: string, filename: string): GrammarLoader {
  return async () => {
    const loader = rawGrammarModules[path];
    if (!loader) {
      throw new Error(`Missing grammar: ${path}`);
    }
    const raw = await loader();
    return parseRawGrammar(raw, filename);
  };
}

const grammarLoaders = new Map<string, GrammarLoader>([
  ["source.css", loadRawGrammar("../grammars/css.tmLanguage.json", "css.tmLanguage.json")],
  ["source.ts", loadRawGrammar("../grammars/typescript.tmLanguage.json", "typescript.tmLanguage.json")],
  ["source.tsx", loadRawGrammar("../grammars/typescriptreact.tmLanguage.json", "typescriptreact.tmLanguage.json")],
  ["source.js", loadRawGrammar("../grammars/javascript.tmLanguage.json", "javascript.tmLanguage.json")],
  ["source.js.jsx", loadRawGrammar("../grammars/javascriptreact.tmLanguage.json", "javascriptreact.tmLanguage.json")],
  ["source.jsdoc.ts", loadRawGrammar("../grammars/jsdoc-ts.tmLanguage.json", "jsdoc-ts.tmLanguage.json")],
  ["source.jsdoc.js", loadRawGrammar("../grammars/jsdoc-js.tmLanguage.json", "jsdoc-js.tmLanguage.json")],
  ["text.html.basic", loadRawGrammar("../grammars/html.tmLanguage.json", "html.tmLanguage.json")],
  ["text.html.derivative", loadRawGrammar("../grammars/html-derivative.tmLanguage.json", "html-derivative.tmLanguage.json")],
  ["source.json", loadRawGrammar("../grammars/json.tmLanguage.json", "json.tmLanguage.json")],
  ["source.css.tailwind", loadRawGrammar("../grammars/source.css.tailwind.tmLanguage.json", "source.css.tailwind.tmLanguage.json")],
  ["text.html.vue", loadRawGrammar("../grammars/vue.tmLanguage.json", "vue.tmLanguage.json")],
  ["source.astro", loadRawGrammar("../grammars/astro.tmLanguage.json", "astro.tmLanguage.json")],
  ["source.svelte", loadRawGrammar("../grammars/svelte.tmLanguage.json", "svelte.tmLanguage.json")],
  ["source.toml", loadRawGrammar("../grammars/toml.tmLanguage.json", "toml.tmLanguage.json")],
  ["source.prisma", loadRawGrammar("../grammars/prisma.tmLanguage.json", "prisma.tmLanguage.json")],
  ["source.sass", loadRawGrammar("../grammars/sass.tmLanguage.json", "sass.tmLanguage.json")],
  ["source.stylus", loadRawGrammar("../grammars/stylus.tmLanguage.json", "stylus.tmLanguage.json")],
  ["source.css.postcss", loadRawGrammar("../grammars/postcss.tmLanguage.json", "postcss.tmLanguage.json")],
  ["source.json5", loadRawGrammar("../grammars/json5.tmLanguage.json", "json5.tmLanguage.json")],
  ["source.hjson", loadRawGrammar("../grammars/hjson.tmLanguage.json", "hjson.tmLanguage.json")],
  ["source.json.lines", loadRawGrammar("../grammars/jsonl.tmLanguage.json", "jsonl.tmLanguage.json")],
  ["markdown.mermaid.codeblock", loadRawGrammar("../grammars/mermaid.tmLanguage.json", "mermaid.tmLanguage.json")],
  ["source.cmake", loadRawGrammar("../grammars/cmake.tmLanguage.json", "cmake.tmLanguage.json")],
  ["source.nix", loadRawGrammar("../grammars/nix.tmLanguage.json", "nix.tmLanguage.json")],
  ["source.zig", loadRawGrammar("../grammars/zig.tmLanguage.json", "zig.tmLanguage.json")],
  ["source.haskell", loadRawGrammar("../grammars/haskell.tmLanguage.json", "haskell.tmLanguage.json")],
  ["source.ocaml", loadRawGrammar("../grammars/ocaml.tmLanguage.json", "ocaml.tmLanguage.json")],
  ["source.elm", loadRawGrammar("../grammars/elm.tmLanguage.json", "elm.tmLanguage.json")],
  ["source.gleam", loadRawGrammar("../grammars/gleam.tmLanguage.json", "gleam.tmLanguage.json")],
  ["source.purescript", loadRawGrammar("../grammars/purescript.tmLanguage.json", "purescript.tmLanguage.json")],
  ["source.gdscript", loadRawGrammar("../grammars/gdscript.tmLanguage.json", "gdscript.tmLanguage.json")],
  ["source.crystal", loadRawGrammar("../grammars/crystal.tmLanguage.json", "crystal.tmLanguage.json")],
  ["source.erlang", loadRawGrammar("../grammars/erlang.tmLanguage.json", "erlang.tmLanguage.json")],
  ["source.v", loadRawGrammar("../grammars/v.tmLanguage.json", "v.tmLanguage.json")],
  ["source.cue", loadRawGrammar("../grammars/cue.tmLanguage.json", "cue.tmLanguage.json")],
  ["source.jsonnet", loadRawGrammar("../grammars/jsonnet.tmLanguage.json", "jsonnet.tmLanguage.json")],
  ["source.fish", loadRawGrammar("../grammars/fish.tmLanguage.json", "fish.tmLanguage.json")],
  ["source.viml", loadRawGrammar("../grammars/viml.tmLanguage.json", "viml.tmLanguage.json")],
  ["text.html.erb", loadRawGrammar("../grammars/erb.tmLanguage.json", "erb.tmLanguage.json")],
  ["text.html.php.blade", loadRawGrammar("../grammars/blade.tmLanguage.json", "blade.tmLanguage.json")],
  ["text.haml", loadRawGrammar("../grammars/haml.tmLanguage.json", "haml.tmLanguage.json")],
  ["source.glsl", loadRawGrammar("../grammars/glsl.tmLanguage.json", "glsl.tmLanguage.json")],
  ["source.hlsl", loadRawGrammar("../grammars/hlsl.tmLanguage.json", "hlsl.tmLanguage.json")],
  ["text.html.markdown", loadRawGrammar("../grammars/markdown.tmLanguage.json", "markdown.tmLanguage.json")],
  ["source.yaml", loadRawGrammar("../grammars/yaml.tmLanguage.json", "yaml.tmLanguage.json")],
  ["source.yaml.1.2", loadRawGrammar("../grammars/yaml-1.2.tmLanguage.json", "yaml-1.2.tmLanguage.json")],
  ["source.yaml.1.3", loadRawGrammar("../grammars/yaml-1.3.tmLanguage.json", "yaml-1.3.tmLanguage.json")],
  ["source.yaml.1.1", loadRawGrammar("../grammars/yaml-1.1.tmLanguage.json", "yaml-1.1.tmLanguage.json")],
  ["source.yaml.1.0", loadRawGrammar("../grammars/yaml-1.0.tmLanguage.json", "yaml-1.0.tmLanguage.json")],
  ["source.yaml.embedded", loadRawGrammar("../grammars/yaml-embedded.tmLanguage.json", "yaml-embedded.tmLanguage.json")],
  ["source.shell", loadRawGrammar("../grammars/shellscript.tmLanguage.json", "shellscript.tmLanguage.json")],
  ["source.dotenv", loadRawGrammar("../grammars/dotenv.tmLanguage.json", "dotenv.tmLanguage.json")],
  ["source.json.comments", loadRawGrammar("../grammars/jsonc.tmLanguage.json", "jsonc.tmLanguage.json")],
  ["source.rust", loadRawGrammar("../grammars/rust.tmLanguage.json", "rust.tmLanguage.json")],
  ["source.ruby", loadRawGrammar("../grammars/ruby.tmLanguage.json", "ruby.tmLanguage.json")],
  ["text.xml", loadRawGrammar("../grammars/xml.tmLanguage.json", "xml.tmLanguage.json")],
  ["source.php", loadRawGrammar("../grammars/php.tmLanguage.json", "php.tmLanguage.json")],
  ["source.css.scss", loadRawGrammar("../grammars/scss.tmLanguage.json", "scss.tmLanguage.json")],
  ["source.css.less", loadRawGrammar("../grammars/less.tmLanguage.json", "less.tmLanguage.json")],
  ["source.dockerfile", loadRawGrammar("../grammars/dockerfile.tmLanguage.json", "dockerfile.tmLanguage.json")],
  ["source.go", loadRawGrammar("../grammars/go.tmLanguage.json", "go.tmLanguage.json")],
  ["source.python", loadRawGrammar("../grammars/python.tmLanguage.json", "python.tmLanguage.json")],
  ["source.c", loadRawGrammar("../grammars/c.tmLanguage.json", "c.tmLanguage.json")],
  ["source.cpp", loadRawGrammar("../grammars/cpp.tmLanguage.json", "cpp.tmLanguage.json")],
  ["source.java", loadRawGrammar("../grammars/java.tmLanguage.json", "java.tmLanguage.json")],
  ["source.cs", loadRawGrammar("../grammars/csharp.tmLanguage.json", "csharp.tmLanguage.json")],
  ["source.swift", loadRawGrammar("../grammars/swift.tmLanguage.json", "swift.tmLanguage.json")],
  ["source.lua", loadRawGrammar("../grammars/lua.tmLanguage.json", "lua.tmLanguage.json")],
  ["source.makefile", loadRawGrammar("../grammars/makefile.tmLanguage.json", "makefile.tmLanguage.json")],
  ["source.ini", loadRawGrammar("../grammars/ini.tmLanguage.json", "ini.tmLanguage.json")],
  ["text.html.handlebars", loadRawGrammar("../grammars/handlebars.tmLanguage.json", "handlebars.tmLanguage.json")],
  ["source.perl", loadRawGrammar("../grammars/perl.tmLanguage.json", "perl.tmLanguage.json")],
  ["source.powershell", loadRawGrammar("../grammars/powershell.tmLanguage.json", "powershell.tmLanguage.json")],
  ["source.r", loadRawGrammar("../grammars/r.tmLanguage.json", "r.tmLanguage.json")],
  ["source.objc", loadRawGrammar("../grammars/objective-c.tmLanguage.json", "objective-c.tmLanguage.json")],
  ["source.dart", loadRawGrammar("../grammars/dart.tmLanguage.json", "dart.tmLanguage.json")],
  ["source.groovy", loadRawGrammar("../grammars/groovy.tmLanguage.json", "groovy.tmLanguage.json")],
  ["source.clojure", loadRawGrammar("../grammars/clojure.tmLanguage.json", "clojure.tmLanguage.json")],
  ["text.tex.latex", loadRawGrammar("../grammars/latex.tmLanguage.json", "latex.tmLanguage.json")],
  ["text.pug", loadRawGrammar("../grammars/pug.tmLanguage.json", "pug.tmLanguage.json")],
  ["source.fsharp", loadRawGrammar("../grammars/fsharp.tmLanguage.json", "fsharp.tmLanguage.json")],
  ["text.html.smarty", loadRawGrammar("../grammars/smarty.tmLanguage.json", "smarty.tmLanguage.json")],
  ["inline.lit-html", loadRawGrammar("../grammars/lit-html.json", "lit-html.json")],
  ["inline.lit-html.string.injection", loadRawGrammar("../grammars/lit-html-string-injection.json", "lit-html-string-injection.json")],
  ["inline.lit-html.style.injection", loadRawGrammar("../grammars/lit-html-style-injection.json", "lit-html-style-injection.json")],
  ["tailwindcss.at-rules.injection", loadRawGrammar("../grammars/tailwindcss-at-rules.tmLanguage.json", "tailwindcss-at-rules.tmLanguage.json")],
  ["tailwindcss.at-apply.injection", loadRawGrammar("../grammars/tailwindcss-at-apply.tmLanguage.json", "tailwindcss-at-apply.tmLanguage.json")],
  ["tailwindcss.theme-fn.injection", loadRawGrammar("../grammars/tailwindcss-theme-fn.tmLanguage.json", "tailwindcss-theme-fn.tmLanguage.json")],
  ["vue.directives", loadRawGrammar("../grammars/vue-directives.json", "vue-directives.json")],
]);

const languageScopes = new Map<string, string>();
const grammarSourceCache = new Map<string, Promise<IRawGrammar | null>>();
const startedGrammarLoads = new Map<string, Promise<void>>();
const tmProviders = new Map<string, monaco.languages.TokensProvider>();
let registryPromise: Promise<Registry> | null = null;

// Seed the active color map so early tokenize calls (before applyTheme runs)
// have something to resolve against. Replaced once setTextMateTheme runs.
const bootstrapRegistry = new Registry({
  onigLib: Promise.resolve({ createOnigScanner, createOnigString }),
  theme: toTextMateRawTheme(defaultDark),
  loadGrammar: async () => null,
});
setActiveColorMap(bootstrapRegistry.getColorMap());

export async function loadGrammarSource(scopeName: string): Promise<IRawGrammar | null> {
  let promise = grammarSourceCache.get(scopeName);
  if (!promise) {
    const loader = grammarLoaders.get(scopeName);
    promise = loader ? loader().catch(() => null) : Promise.resolve(null);
    grammarSourceCache.set(scopeName, promise);
  }
  return promise;
}

function getRegistry(): Promise<Registry> {
  if (registryPromise) return registryPromise;
  registryPromise = (async () => {
    const wasmUrl = new URL("vscode-oniguruma/release/onig.wasm", import.meta.url);
    const wasmData = await fetch(wasmUrl).then((r) => r.arrayBuffer());
    await loadWASM(wasmData);

    return new Registry({
      onigLib: Promise.resolve({ createOnigScanner, createOnigString }),
      theme: toTextMateRawTheme(defaultDark),
      loadGrammar: (scopeName) => loadGrammarSource(scopeName),
      getInjections(scopeName) {
        if (scopeName === "source.css" || scopeName === "source.css.tailwind") {
          return [
            "tailwindcss.at-rules.injection",
            "tailwindcss.at-apply.injection",
            "tailwindcss.theme-fn.injection",
          ];
        }
        const litInjections = [
          "inline.lit-html",
          "inline.lit-html.string.injection",
          "inline.lit-html.style.injection",
        ];
        if (scopeName === "source.ts" || scopeName === "source.tsx") {
          return ["source.jsdoc.ts", ...litInjections];
        }
        if (scopeName === "source.js" || scopeName === "source.js.jsx") {
          return ["source.jsdoc.js", ...litInjections];
        }
        if (scopeName === "text.html.vue" || scopeName === "text.html.derivative" || scopeName === "text.html.basic") {
          return ["vue.directives"];
        }
        return undefined;
      },
    });
  })();
  return registryPromise;
}

class TmState implements monaco.languages.IState {
  constructor(public readonly stack: StateStack) {}
  clone() { return new TmState(this.stack); }
  equals(other: monaco.languages.IState) {
    return other instanceof TmState && this.stack === other.stack;
  }
}

function forceRetokenize(model: monaco.editor.ITextModel) {
  const lang = model.getLanguageId();
  monaco.editor.setModelLanguage(model, "plaintext");
  monaco.editor.setModelLanguage(model, lang);
}

const originalSetTokensProvider = monaco.languages.setTokensProvider.bind(monaco.languages);
monaco.languages.setTokensProvider = (languageId: string, provider: any) => {
  if (tmProviders.has(languageId) && provider !== tmProviders.get(languageId)) {
    return { dispose() {} };
  }
  return originalSetTokensProvider(languageId, provider);
};

function createPlaceholderProvider(): monaco.languages.TokensProvider {
  return {
    getInitialState: () => new TmState(INITIAL),
    tokenize: (_line: string, state: monaco.languages.IState) => ({
      tokens: [{ startIndex: 0, scopes: "" }],
      endState: state,
    }),
  };
}

function createTmProvider(grammar: any): monaco.languages.TokensProvider {
  return {
    getInitialState: () => new TmState(INITIAL),
    tokenize(line: string, state: monaco.languages.IState) {
      if (line.length >= MAX_SAFE_TOKENIZATION_LINE_LENGTH) {
        return {
          tokens: [{ startIndex: 0, scopes: "" }],
          endState: state,
        };
      }
      const result = grammar.tokenizeLine2(line, (state as TmState).stack);
      const tokens: { startIndex: number; scopes: string }[] = [];
      for (let i = 0; i < result.tokens.length; i += 2) {
        tokens.push({
          startIndex: result.tokens[i],
          scopes: metadataToTokenName(result.tokens[i + 1]),
        });
      }
      return { tokens, endState: new TmState(result.ruleStack) };
    },
  };
}

export function registerTextMateLanguage(languageId: string, scopeName: string): void {
  languageScopes.set(languageId, scopeName);
  if (!tmProviders.has(languageId)) {
    const provider = createPlaceholderProvider();
    tmProviders.set(languageId, provider);
    originalSetTokensProvider(languageId, provider);
  }
}

export async function ensureGrammar(languageId: string): Promise<void> {
  const existing = startedGrammarLoads.get(languageId);
  if (existing) return existing;

  const scopeName = languageScopes.get(languageId);
  if (!scopeName) return;

  const ready = (async () => {
    const registry = await getRegistry();
    const grammar = await registry.loadGrammar(scopeName);
    if (!grammar) return;

    const provider = createTmProvider(grammar);
    tmProviders.set(languageId, provider);
    originalSetTokensProvider(languageId, provider);

    for (const model of monaco.editor.getModels()) {
      if (model.getLanguageId() === languageId) {
        forceRetokenize(model);
      }
    }
  })();

  startedGrammarLoads.set(languageId, ready);
  return ready;
}

export function grammarsReady(): Promise<void> {
  return Promise.all(startedGrammarLoads.values()).then(() => {});
}

export function applyTextMateToModel(model: monaco.editor.ITextModel): void {
  const lang = model.getLanguageId();
  ensureGrammar(lang).then(() => {
    if (!model.isDisposed()) forceRetokenize(model);
  });
}

monaco.editor.onDidCreateModel((model) => {
  const lang = model.getLanguageId();
  if (!languageScopes.has(lang)) return;
  ensureGrammar(lang).then(() => {
    if (!model.isDisposed()) forceRetokenize(model);
  });
});

export async function setTextMateTheme(theme: VerneTheme): Promise<string[]> {
  const registry = await getRegistry();
  registry.setTheme(toTextMateRawTheme(theme));
  const colorMap = registry.getColorMap();
  setActiveColorMap(colorMap);
  return colorMap;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const CODE_BLOCK_SCOPE_MAP: Record<string, string> = {
  typescript: "source.ts",
  ts: "source.ts",
  javascript: "source.js",
  js: "source.js",
  jsx: "source.js.jsx",
  tsx: "source.tsx",
  vue: "text.html.vue",
  astro: "source.astro",
  svelte: "source.svelte",
  toml: "source.toml",
  prisma: "source.prisma",
  html: "text.html.basic",
  json: "source.json",
  css: "source.css.tailwind",
  markdown: "text.html.markdown",
  md: "text.html.markdown",
  yaml: "source.yaml",
  yml: "source.yaml",
  sh: "source.shell",
  bash: "source.shell",
  shell: "source.shell",
  zsh: "source.shell",
  env: "source.dotenv",
  dotenv: "source.dotenv",
  jsonc: "source.json.comments",
  rust: "source.rust",
  rs: "source.rust",
  ruby: "source.ruby",
  rb: "source.ruby",
  xml: "text.xml",
  svg: "text.xml",
  php: "source.php",
  scss: "source.css.scss",
  less: "source.css.less",
  dockerfile: "source.dockerfile",
  go: "source.go",
  python: "source.python",
  py: "source.python",
  c: "source.c",
  cpp: "source.cpp",
  cc: "source.cpp",
  h: "source.c",
  hpp: "source.cpp",
  java: "source.java",
  csharp: "source.cs",
  cs: "source.cs",
  swift: "source.swift",
  lua: "source.lua",
  makefile: "source.makefile",
  make: "source.makefile",
  ini: "source.ini",
  cfg: "source.ini",
  handlebars: "text.html.handlebars",
  hbs: "text.html.handlebars",
  perl: "source.perl",
  pl: "source.perl",
  powershell: "source.powershell",
  ps1: "source.powershell",
  r: "source.r",
  objectivec: "source.objc",
  objc: "source.objc",
  dart: "source.dart",
  groovy: "source.groovy",
  gradle: "source.groovy",
  clojure: "source.clojure",
  clj: "source.clojure",
  latex: "text.tex.latex",
  tex: "text.tex.latex",
  pug: "text.pug",
  jade: "text.pug",
  fsharp: "source.fsharp",
  fs: "source.fsharp",
  smarty: "text.html.smarty",
  tpl: "text.html.smarty",
};

export async function tokenizeCodeBlockToHtml(code: string, lang: string): Promise<string> {
  const scopeName = CODE_BLOCK_SCOPE_MAP[lang.toLowerCase()];
  if (!scopeName) return escapeHtml(code);

  const registry = await getRegistry();
  const grammar = await registry.loadGrammar(scopeName);
  if (!grammar) return escapeHtml(code);

  const lines = code.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();

  let ruleStack = INITIAL;
  const htmlLines: string[] = [];
  for (const line of lines) {
    const result = grammar.tokenizeLine2(line, ruleStack);
    ruleStack = result.ruleStack;

    let html = "";
    for (let i = 0; i < result.tokens.length; i += 2) {
      const startIndex = result.tokens[i];
      const nextStart = i + 2 < result.tokens.length ? result.tokens[i + 2] : line.length;
      const text = line.slice(startIndex, nextStart);
      if (!text) continue;
      const meta = result.tokens[i + 1];
      const color = resolveColorFromMetadata(meta);
      const fontStyle = resolveFontStyleFromMetadata(meta);
      const escaped = escapeHtml(text);

      let style = color ? `color:${color}` : "";
      if (fontStyle & 1) style += ";font-style:italic";
      if (fontStyle & 2) style += ";font-weight:bold";
      if (fontStyle & 4) style += ";text-decoration:underline";
      if (fontStyle & 8) {
        style += style.includes("text-decoration")
          ? " line-through"
          : ";text-decoration:line-through";
      }

      html += style ? `<span style="${style}">${escaped}</span>` : escaped;
    }
    htmlLines.push(html);
  }

  return htmlLines.join("\n");
}
