import { createFileTreeIconResolver, getBuiltInSpriteSheet } from "@pierre/trees";

const resolver = createFileTreeIconResolver({ set: "complete", colored: true });

const TOKENS = [
  "astro","babel","bash","biome","bootstrap","browserslist","bun","c","cpp","claude",
  "css","database","default","docker","eslint","git","go","graphql","html","image",
  "javascript","json","markdown","mcp","npm","oxc","postcss","prettier","python",
  "react","ruby","rust","sass","svg","svelte","svgo","swift","table","text",
  "tailwind","terraform","typescript","vite","vscode","vue","wasm","webpack","yml",
  "zig","zip",
] as const;

const COLOR_CSS = `
:root {
  --trees-icon-gray: light-dark(#84848a, #adadb1);
  --trees-icon-red: light-dark(#d52c36, #ff6762);
  --trees-icon-vermilion: light-dark(#ff8c5b, #d5512f);
  --trees-icon-orange: light-dark(#d47628, #ffa359);
  --trees-icon-yellow: light-dark(#d5a910, #ffd452);
  --trees-icon-green: light-dark(#199f43, #5ecc71);
  --trees-icon-teal: light-dark(#17a5af, #64d1db);
  --trees-icon-cyan: light-dark(#1ca1c7, #68cdf2);
  --trees-icon-blue: light-dark(#1a85d4, #69b1ff);
  --trees-icon-indigo: light-dark(#693acf, #9d6afb);
  --trees-icon-purple: light-dark(#a631be, #d568ea);
  --trees-icon-pink: light-dark(#d32a61, #ff678d);
  --trees-icon-mauve: light-dark(#594c5b, #79697b);
  --trees-file-icon-color-default: var(--trees-icon-gray);
  --trees-file-icon-color-astro: var(--trees-icon-purple);
  --trees-file-icon-color-babel: var(--trees-icon-yellow);
  --trees-file-icon-color-bash: var(--trees-icon-green);
  --trees-file-icon-color-biome: var(--trees-icon-blue);
  --trees-file-icon-color-bootstrap: var(--trees-icon-indigo);
  --trees-file-icon-color-browserslist: var(--trees-icon-yellow);
  --trees-file-icon-color-bun: var(--trees-icon-mauve);
  --trees-file-icon-color-c: var(--trees-icon-blue);
  --trees-file-icon-color-cpp: var(--trees-icon-blue);
  --trees-file-icon-color-claude: var(--trees-icon-orange);
  --trees-file-icon-color-css: var(--trees-icon-indigo);
  --trees-file-icon-color-database: var(--trees-icon-purple);
  --trees-file-icon-color-docker: var(--trees-icon-blue);
  --trees-file-icon-color-eslint: var(--trees-icon-indigo);
  --trees-file-icon-color-git: var(--trees-icon-vermilion);
  --trees-file-icon-color-go: var(--trees-icon-cyan);
  --trees-file-icon-color-graphql: var(--trees-icon-pink);
  --trees-file-icon-color-html: var(--trees-icon-orange);
  --trees-file-icon-color-image: var(--trees-icon-pink);
  --trees-file-icon-color-javascript: var(--trees-icon-yellow);
  --trees-file-icon-color-json: var(--trees-icon-orange);
  --trees-file-icon-color-markdown: var(--trees-icon-green);
  --trees-file-icon-color-mcp: var(--trees-icon-teal);
  --trees-file-icon-color-npm: var(--trees-icon-red);
  --trees-file-icon-color-oxc: var(--trees-icon-cyan);
  --trees-file-icon-color-postcss: var(--trees-icon-red);
  --trees-file-icon-color-prettier: var(--trees-icon-teal);
  --trees-file-icon-color-python: var(--trees-icon-blue);
  --trees-file-icon-color-react: var(--trees-icon-cyan);
  --trees-file-icon-color-ruby: var(--trees-icon-red);
  --trees-file-icon-color-rust: var(--trees-icon-orange);
  --trees-file-icon-color-sass: var(--trees-icon-pink);
  --trees-file-icon-color-svg: var(--trees-icon-orange);
  --trees-file-icon-color-svelte: var(--trees-icon-red);
  --trees-file-icon-color-svgo: var(--trees-icon-green);
  --trees-file-icon-color-swift: var(--trees-icon-orange);
  --trees-file-icon-color-table: var(--trees-icon-teal);
  --trees-file-icon-color-text: var(--trees-icon-gray);
  --trees-file-icon-color-tailwind: var(--trees-icon-cyan);
  --trees-file-icon-color-terraform: var(--trees-icon-indigo);
  --trees-file-icon-color-typescript: var(--trees-icon-blue);
  --trees-file-icon-color-vite: var(--trees-icon-purple);
  --trees-file-icon-color-vscode: var(--trees-icon-blue);
  --trees-file-icon-color-vue: var(--trees-icon-green);
  --trees-file-icon-color-wasm: var(--trees-icon-indigo);
  --trees-file-icon-color-webpack: var(--trees-icon-blue);
  --trees-file-icon-color-yml: var(--trees-icon-red);
  --trees-file-icon-color-zig: var(--trees-icon-orange);
  --trees-file-icon-color-zip: var(--trees-icon-orange);
}
.verne-file-icon { color: var(--trees-file-icon-color-default); fill: currentColor; }
${TOKENS.map((t) => `.verne-file-icon[data-icon-token='${t}'] { color: var(--trees-file-icon-color-${t}); }`).join("\n")}
`;

let injected = false;
function ensureInjected() {
  if (injected || typeof document === "undefined") return;
  injected = true;
  const wrapper = document.createElement("div");
  wrapper.innerHTML = getBuiltInSpriteSheet("complete");
  const svg = wrapper.firstElementChild;
  if (svg instanceof SVGElement) {
    svg.setAttribute("aria-hidden", "true");
    Object.assign(svg.style, { position: "absolute", width: "0", height: "0", overflow: "hidden" });
    document.body.appendChild(svg);
  }
  const style = document.createElement("style");
  style.dataset.verneFileIcons = "";
  style.textContent = COLOR_CSS;
  document.head.appendChild(style);
}

// symbolId -> { inner, viewBox } parsed once from the sprite source. String
// parse (not DOMParser): the sprite root <svg> has no xmlns, so
// DOMParser("image/svg+xml") fails to find symbols. The sprite is a stable,
// machine-generated string, so a targeted regex is reliable here.
let symbolIndex: Map<string, { inner: string; viewBox: string }> | null = null;
function spriteSymbols(): Map<string, { inner: string; viewBox: string }> {
  if (symbolIndex) return symbolIndex;
  symbolIndex = new Map();
  const sprite = getBuiltInSpriteSheet("complete");
  const re = /<symbol\b([^>]*)>([\s\S]*?)<\/symbol>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sprite))) {
    const id = (m[1].match(/\bid="([^"]+)"/) || [])[1];
    if (!id) continue;
    const viewBox = (m[1].match(/\bviewBox="([^"]+)"/) || [])[1] ?? "0 0 16 16";
    symbolIndex.set(id, { inner: m[2], viewBox });
  }
  return symbolIndex;
}

// symbolId -> cached `mask-image` data-URI (decoded once per glyph by the browser).
const maskUrlCache = new Map<string, string>();
function maskUrlForSymbol(symbolId: string): string {
  const cached = maskUrlCache.get(symbolId);
  if (cached) return cached;
  const sym = spriteSymbols().get(symbolId);
  const viewBox = sym?.viewBox ?? "0 0 16 16";
  // Force opaque fills so the mask's alpha channel == the glyph shape (mask-mode
  // is alpha for image sources). currentColor would be ambiguous in a detached
  // image context.
  const inner = (sym?.inner ?? "").replace(/currentColor/g, "#000");
  // Explicit width/height: WebKit needs intrinsic size for `mask-size: contain`.
  const [, , w = "16", h = "16"] = viewBox.split(/\s+/);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${viewBox}">${inner}</svg>`;
  const url = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  maskUrlCache.set(symbolId, url);
  return url;
}

export interface ResolvedFileIcon {
  symbolId: string;
  token?: string;
  viewBox: string;
}

export function resolveFileIcon(filename: string): ResolvedFileIcon {
  ensureInjected();
  const r = resolver.resolveIcon("file-tree-icon-file", filename);
  return {
    symbolId: r.name,
    token: r.token,
    viewBox: r.viewBox ?? "0 0 16 16",
  };
}

export interface ResolvedFileIconMask {
  maskUrl: string; // ready for `mask-image` / `-webkit-mask-image`
  token?: string;  // semantic color token, e.g. "typescript"
}

export function resolveFileIconMask(filename: string): ResolvedFileIconMask {
  const r = resolveFileIcon(filename); // ensures sprite + color CSS injected
  return { maskUrl: maskUrlForSymbol(r.symbolId), token: r.token };
}

// Built-in non-file glyphs (folder uses chevron rotation in the row CSS).
export function chevronMaskUrl(): string {
  resolveFileIcon("x"); // ensure injected
  return maskUrlForSymbol("file-tree-icon-chevron");
}
