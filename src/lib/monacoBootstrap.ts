import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import defaultDarkRaw from "../themes/default-dark.verne.json";
import type { VerneTheme } from "@/types/theme";
import { registerTextMateLanguage, setTextMateTheme } from "./textmate";
import { buildMonacoRulesFromColorMap } from "./themeTokens";
import { buildMonacoTheme } from "./themeAdapter";

const defaultDark = defaultDarkRaw as unknown as VerneTheme;

let monacoReady = false;
let monacoReadyPromise: Promise<void> | null = null;
let typeScriptBuiltInHoversSuppressed = false;
let typeScriptHoverGateInstalled = false;

const TYPE_SCRIPT_HOVER_LANGUAGES = new Set(["typescript", "javascript"]);

function isTypeScriptBuiltInHoverProvider(provider: monaco.languages.HoverProvider): boolean {
  return provider.constructor?.name === "QuickInfoAdapter";
}

function installTypeScriptHoverGate(): void {
  if (typeScriptHoverGateInstalled) return;
  typeScriptHoverGateInstalled = true;

  const registerHoverProvider = monaco.languages.registerHoverProvider.bind(monaco.languages);
  monaco.languages.registerHoverProvider = (languageId, provider) => {
    if (
      typeof languageId === "string"
      && TYPE_SCRIPT_HOVER_LANGUAGES.has(languageId)
      && isTypeScriptBuiltInHoverProvider(provider)
    ) {
      return registerHoverProvider(languageId, {
        provideHover(model, position, token) {
          if (typeScriptBuiltInHoversSuppressed) return null;
          return provider.provideHover(model, position, token);
        },
      });
    }

    return registerHoverProvider(languageId, provider);
  };
}

export function setTypeScriptBuiltInHoversSuppressed(suppressed: boolean): void {
  typeScriptBuiltInHoversSuppressed = suppressed;
}

function registerLanguages() {
  monaco.languages.register({
    id: "tailwindcss",
    extensions: [".css"],
    aliases: ["Tailwind CSS", "CSS"],
  });
  monaco.languages.register({ id: "vue", extensions: [".vue"], aliases: ["Vue", "Vue SFC"] });
  monaco.languages.register({ id: "dotenv", extensions: [".env"], aliases: ["DotENV"] });
  monaco.languages.register({ id: "jsonc", extensions: [".jsonc"], aliases: ["JSON with Comments"] });

  monaco.languages.setLanguageConfiguration("jsonc", {
    comments: { lineComment: "//", blockComment: ["/*", "*/"] },
    brackets: [["{", "}"], ["[", "]"]],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: '"', close: '"', notIn: ["string"] },
    ],
  });
  monaco.languages.setLanguageConfiguration("dotenv", {
    comments: { lineComment: "#" },
  });
  monaco.languages.setLanguageConfiguration("tailwindcss", {
    comments: { blockComment: ["/*", "*/"] },
    brackets: [["{", "}"], ["(", ")"], ["[", "]"]],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: "'", close: "'", notIn: ["string", "comment"] },
      { open: '"', close: '"', notIn: ["string"] },
    ],
    surroundingPairs: [
      { open: "'", close: "'" },
      { open: '"', close: '"' },
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
    ],
  });

  // Register extra extensions for existing languages
  monaco.languages.register({ id: "javascript", extensions: [".cjs", ".mjs"] });
  monaco.languages.register({ id: "typescript", extensions: [".cts", ".mts"] });

  // Register new languages
  monaco.languages.register({ id: "xml", extensions: [".xml", ".svg", ".xsl", ".xsd", ".plist"] });
  monaco.languages.register({ id: "php", extensions: [".php"] });
  monaco.languages.register({ id: "scss", extensions: [".scss"] });
  monaco.languages.register({ id: "less", extensions: [".less"] });
  monaco.languages.register({ id: "dockerfile", extensions: [".dockerfile"], filenames: ["Dockerfile", "Dockerfile.*"] });
  monaco.languages.register({ id: "go", extensions: [".go"] });
  monaco.languages.register({ id: "python", extensions: [".py", ".pyw"] });
  monaco.languages.register({ id: "c", extensions: [".c", ".h"] });
  monaco.languages.register({ id: "cpp", extensions: [".cpp", ".cc", ".cxx", ".hpp", ".hxx", ".hh"] });
  monaco.languages.register({ id: "java", extensions: [".java"] });
  monaco.languages.register({ id: "csharp", extensions: [".cs", ".csx"] });
  monaco.languages.register({ id: "swift", extensions: [".swift"] });
  monaco.languages.register({ id: "lua", extensions: [".lua"] });
  monaco.languages.register({ id: "makefile", filenames: ["Makefile", "makefile", "GNUmakefile"] });
  monaco.languages.register({ id: "ini", extensions: [".ini", ".cfg", ".conf", ".properties"] });
  monaco.languages.register({ id: "handlebars", extensions: [".hbs", ".handlebars"] });
  monaco.languages.register({ id: "perl", extensions: [".pl", ".pm"] });
  monaco.languages.register({ id: "powershell", extensions: [".ps1", ".psd1", ".psm1"] });
  monaco.languages.register({ id: "r", extensions: [".r", ".R"] });
  monaco.languages.register({ id: "objective-c", extensions: [".m", ".mm"] });
  monaco.languages.register({ id: "dart", extensions: [".dart"] });
  monaco.languages.register({ id: "groovy", extensions: [".groovy", ".gradle"] });
  monaco.languages.register({ id: "clojure", extensions: [".clj", ".cljs", ".edn"] });
  monaco.languages.register({ id: "latex", extensions: [".tex", ".sty", ".cls"] });
  monaco.languages.register({ id: "pug", extensions: [".pug", ".jade"] });
  monaco.languages.register({ id: "fsharp", extensions: [".fs", ".fsi", ".fsx"] });
  monaco.languages.register({ id: "smarty", extensions: [".tpl", ".smarty"] });
  monaco.languages.register({ id: "mdx", extensions: [".mdx"], aliases: ["MDX"] });
  monaco.languages.register({ id: "mdc", extensions: [".mdc"], aliases: ["MDC"] });

  monaco.languages.setLanguageConfiguration("mdx", {
    comments: { blockComment: ["{/*", "*/}"] },
    brackets: [["{", "}"], ["[", "]"], ["(", ")"]],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: "<", close: ">" },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
    ],
  });

  // Existing languages
  registerTextMateLanguage("typescript", "source.ts");
  registerTextMateLanguage("javascript", "source.js");
  registerTextMateLanguage("html", "text.html.basic");
  registerTextMateLanguage("json", "source.json");
  registerTextMateLanguage("tailwindcss", "source.css.tailwind");
  registerTextMateLanguage("vue", "text.html.vue");
  registerTextMateLanguage("markdown", "text.html.markdown");
  registerTextMateLanguage("yaml", "source.yaml");
  registerTextMateLanguage("shell", "source.shell");
  registerTextMateLanguage("dotenv", "source.dotenv");
  registerTextMateLanguage("jsonc", "source.json.comments");
  registerTextMateLanguage("rust", "source.rust");
  registerTextMateLanguage("ruby", "source.ruby");

  // New languages
  registerTextMateLanguage("xml", "text.xml");
  registerTextMateLanguage("php", "source.php");
  registerTextMateLanguage("scss", "source.css.scss");
  registerTextMateLanguage("less", "source.css.less");
  registerTextMateLanguage("dockerfile", "source.dockerfile");
  registerTextMateLanguage("go", "source.go");
  registerTextMateLanguage("python", "source.python");
  registerTextMateLanguage("c", "source.c");
  registerTextMateLanguage("cpp", "source.cpp");
  registerTextMateLanguage("java", "source.java");
  registerTextMateLanguage("csharp", "source.cs");
  registerTextMateLanguage("swift", "source.swift");
  registerTextMateLanguage("lua", "source.lua");
  registerTextMateLanguage("makefile", "source.makefile");
  registerTextMateLanguage("ini", "source.ini");
  registerTextMateLanguage("handlebars", "text.html.handlebars");
  registerTextMateLanguage("perl", "source.perl");
  registerTextMateLanguage("powershell", "source.powershell");
  registerTextMateLanguage("r", "source.r");
  registerTextMateLanguage("objective-c", "source.objc");
  registerTextMateLanguage("dart", "source.dart");
  registerTextMateLanguage("groovy", "source.groovy");
  registerTextMateLanguage("clojure", "source.clojure");
  registerTextMateLanguage("latex", "text.tex.latex");
  registerTextMateLanguage("pug", "text.pug");
  registerTextMateLanguage("fsharp", "source.fsharp");
  registerTextMateLanguage("smarty", "text.html.smarty");
  registerTextMateLanguage("mdx", "source.mdx");
  registerTextMateLanguage("mdc", "text.markdown.mdc");
}

/**
 * Resolve the live TextMate color map for `theme` and install it as Monaco's
 * theme. Critical: the `fg{N}` rules Monaco binds MUST come from the same
 * color map TextMate is currently using to tokenize — otherwise indices
 * resolve to a different theme's palette and every token mis-colors.
 */
async function installTheme(theme: VerneTheme, name: string): Promise<void> {
  const colorMap = await setTextMateTheme(theme);
  monaco.editor.defineTheme(
    name,
    buildMonacoTheme(theme, buildMonacoRulesFromColorMap(colorMap)),
  );
  monaco.editor.setTheme(name);
}

export function isMonacoInitialized(): boolean {
  return monacoReady;
}

export async function ensureMonaco(theme: VerneTheme = defaultDark, themeName = "default-dark"): Promise<void> {
  if (monacoReady) {
    await installTheme(theme, themeName);
    return;
  }
  if (monacoReadyPromise) {
    await monacoReadyPromise;
    await installTheme(theme, themeName);
    return;
  }

  monacoReadyPromise = (async () => {
    (self as any).MonacoEnvironment = {
      getWorker(_: string, label: string) {
        if (label === "json") return new jsonWorker();
        if (label === "typescript" || label === "javascript") return new tsWorker();
        if (label === "html" || label === "handlebars" || label === "razor") return new htmlWorker();
        if (label === "css" || label === "scss" || label === "less") return new cssWorker();
        return new editorWorker();
      },
    };

    installTypeScriptHoverGate();
    registerLanguages();
    await installTheme(theme, themeName);

    (monaco.languages as any).typescript.typescriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: true,
    });
    (monaco.languages as any).typescript.javascriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: true,
    });

    monacoReady = true;
  })();

  await monacoReadyPromise;
}
