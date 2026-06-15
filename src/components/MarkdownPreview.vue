<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount, nextTick } from "vue";
import { useSettings } from "@/composables/useSettings";
import { convertFileSrc } from "@/platform";
import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";
import { tokenizeCodeBlockToHtml } from "@/lib/textmate";

// Carries the edit-mode scroll position across the toggle: `initialLine`
// (0-based source line) scrolls to the matching block; `initialBottom` snaps to
// the very bottom (the two views differ in height, so a bottom edit wouldn't map
// to the preview's bottom by line alone).
const props = defineProps<{ content: string; filePath?: string; initialLine?: number; initialBottom?: boolean }>();
const { settings } = useSettings();

const scroller = ref<HTMLElement | null>(null);
const root = ref<HTMLElement | null>(null);
const renderedHtml = ref("");
// Scroll target waiting for content to render (so anchors exist). Applied by
// whichever happens last: the initialLine watcher or the render tail.
let pendingScroll: { line: number; bottom: boolean } | null = null;

// Selection lives in this preview when its anchor/focus node is inside root.
function hasSelectionInPreview(): boolean {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !root.value) return false;
  return root.value.contains(sel.anchorNode) || root.value.contains(sel.focusNode);
}

// Clicking off the preview clears its selection. Chromium leaves a stale
// highlight when the mousedown lands on a user-select:none element (most of
// the app chrome is), so we clear it explicitly.
function onDocMouseDown(e: MouseEvent) {
  if (root.value?.contains(e.target as Node)) return;
  if (hasSelectionInPreview()) window.getSelection()?.removeAllRanges();
}

onMounted(() => document.addEventListener("mousedown", onDocMouseDown, true));
onBeforeUnmount(() => document.removeEventListener("mousedown", onDocMouseDown, true));

// --- scroll ↔ source-line mapping (for edit/preview toggle carry-over) ---
// Each annotated block carries `data-line` (0-based source line). We map a line
// to a content-relative offset by interpolating between the surrounding blocks.
function lineAnchors(): { line: number; top: number }[] {
  const sc = scroller.value;
  if (!sc) return [];
  const base = sc.getBoundingClientRect().top - sc.scrollTop;
  const out: { line: number; top: number }[] = [];
  sc.querySelectorAll<HTMLElement>("[data-line]").forEach((el) => {
    const line = Number(el.getAttribute("data-line"));
    if (Number.isFinite(line)) out.push({ line, top: el.getBoundingClientRect().top - base });
  });
  return out.sort((a, b) => a.line - b.line);
}

function scrollToLine(line: number) {
  const sc = scroller.value;
  const anchors = lineAnchors();
  if (!sc || anchors.length === 0) return;
  // At/above the first block → true top; don't scroll the container padding away.
  if (line <= anchors[0].line) { sc.scrollTop = 0; return; }
  let prev = anchors[0];
  for (const a of anchors) {
    if (a.line === line) { sc.scrollTop = a.top; return; }
    if (a.line > line) {
      const ratio = a.line === prev.line ? 0 : (line - prev.line) / (a.line - prev.line);
      sc.scrollTop = prev.top + (a.top - prev.top) * ratio;
      return;
    }
    prev = a;
  }
  sc.scrollTop = prev.top;
}

function atBottom(): boolean {
  const sc = scroller.value;
  if (!sc || sc.scrollHeight - sc.clientHeight <= 1) return false; // not scrollable
  return sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2;
}

// Source line of the block currently at the top of the viewport.
function topLine(): number {
  const sc = scroller.value;
  const anchors = lineAnchors();
  if (!sc || anchors.length === 0) return 0;
  const vy = sc.scrollTop;
  let result = anchors[0];
  for (const a of anchors) {
    if (a.top <= vy + 1) result = a; else break;
  }
  return result.line;
}

// Apply a queued scroll target once the content (and its anchors) is in the DOM.
function applyPendingScroll() {
  const sc = scroller.value;
  if (!pendingScroll || !sc?.querySelector("[data-line]")) return;
  if (pendingScroll.bottom) sc.scrollTop = sc.scrollHeight;
  else scrollToLine(pendingScroll.line);
  pendingScroll = null;
}

// Each toggle to preview remounts this component, so immediate fires per toggle.
watch(() => [props.initialLine, props.initialBottom], () => {
  if (props.initialLine == null && !props.initialBottom) return;
  pendingScroll = { line: props.initialLine ?? 0, bottom: !!props.initialBottom };
  nextTick(applyPendingScroll);
}, { immediate: true });

defineExpose({ scrollToLine, topLine, atBottom });

const LANG_DISPLAY_NAMES: Record<string, string> = {
  ts: "TypeScript", typescript: "TypeScript",
  js: "JavaScript", javascript: "JavaScript",
  jsx: "JSX", tsx: "TSX",
  vue: "Vue", html: "HTML", css: "CSS",
  json: "JSON", jsonc: "JSON",
  yaml: "YAML", yml: "YAML",
  sh: "Shell", bash: "Bash", shell: "Shell", zsh: "Zsh",
  py: "Python", python: "Python",
  rs: "Rust", rust: "Rust",
  go: "Go", rb: "Ruby", ruby: "Ruby",
  java: "Java", kt: "Kotlin", kotlin: "Kotlin",
  c: "C", cpp: "C++", "c++": "C++",
  cs: "C#", "c#": "C#", csharp: "C#",
  sql: "SQL", graphql: "GraphQL", gql: "GraphQL",
  md: "Markdown", markdown: "Markdown",
  env: "Env", dotenv: "Env",
  toml: "TOML", ini: "INI", xml: "XML",
  swift: "Swift", dart: "Dart", php: "PHP",
  dockerfile: "Dockerfile", docker: "Dockerfile",
  makefile: "Makefile", make: "Makefile",
};

const ALERT_TYPES: Record<string, { icon: string; className: string }> = {
  NOTE: {
    className: "alert-note",
    icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16"><path fill="currentColor" d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm8-6.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM6.5 7.75A.75.75 0 0 1 7.25 7h1a.75.75 0 0 1 .75.75v2.75h.25a.75.75 0 0 1 0 1.5h-2a.75.75 0 0 1 0-1.5h.25v-2h-.25a.75.75 0 0 1-.75-.75ZM8 6a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z"/></svg>`,
  },
  TIP: {
    className: "alert-tip",
    icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16"><path fill="currentColor" d="M8 1.5c-2.363 0-4 1.69-4 3.75 0 .984.424 1.625.984 2.304l.214.253c.223.264.47.556.673.848.284.411.537.896.621 1.49a.75.75 0 0 1-1.484.211c-.04-.282-.163-.547-.37-.847a8.456 8.456 0 0 0-.542-.68c-.084-.1-.173-.205-.268-.32C3.201 7.75 2.5 6.766 2.5 5.25 2.5 2.31 4.863 0 8 0s5.5 2.31 5.5 5.25c0 1.516-.701 2.5-1.328 3.259-.095.115-.184.22-.268.319-.207.245-.383.453-.541.681-.208.3-.33.565-.37.847a.751.751 0 0 1-1.485-.212c.084-.593.337-1.078.621-1.489.203-.292.45-.584.673-.848.075-.088.147-.173.213-.253.561-.679.985-1.32.985-2.304 0-2.06-1.637-3.75-4-3.75ZM5.75 12h4.5a.75.75 0 0 1 0 1.5h-4.5a.75.75 0 0 1 0-1.5ZM6 15.25a.75.75 0 0 1 .75-.75h2.5a.75.75 0 0 1 0 1.5h-2.5a.75.75 0 0 1-.75-.75Z"/></svg>`,
  },
  IMPORTANT: {
    className: "alert-important",
    icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16"><path fill="currentColor" d="M0 1.75C0 .784.784 0 1.75 0h12.5C15.216 0 16 .784 16 1.75v9.5A1.75 1.75 0 0 1 14.25 13H8.06l-2.573 2.573A1.458 1.458 0 0 1 3 14.543V13H1.75A1.75 1.75 0 0 1 0 11.25Zm1.75-.25a.25.25 0 0 0-.25.25v9.5c0 .138.112.25.25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h6.5a.25.25 0 0 0 .25-.25v-9.5a.25.25 0 0 0-.25-.25Zm7 2.25v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 9a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"/></svg>`,
  },
  WARNING: {
    className: "alert-warning",
    icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16"><path fill="currentColor" d="M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"/></svg>`,
  },
  CAUTION: {
    className: "alert-caution",
    icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16"><path fill="currentColor" d="M4.47.22A.749.749 0 0 1 5 0h6c.199 0 .389.079.53.22l4.25 4.25c.141.14.22.331.22.53v6a.749.749 0 0 1-.22.53l-4.25 4.25A.749.749 0 0 1 11 16H5a.749.749 0 0 1-.53-.22L.22 11.53A.749.749 0 0 1 0 11V5c0-.199.079-.389.22-.53Zm.84 1.28L1.5 5.31v5.38l3.81 3.81h5.38l3.81-3.81V5.31L10.69 1.5ZM8 4a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 8 4Zm0 8a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z"/></svg>`,
  },
};

function processAlerts(html: string): string {
  return html.replace(
    /<blockquote[^>]*>\s*<p[^>]*>\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*\n?([\s\S]*?)<\/blockquote>/gi,
    (_match, type: string, body: string) => {
      const key = type.toUpperCase();
      const alert = ALERT_TYPES[key];
      if (!alert) return _match;
      return `<div class="gfm-alert ${alert.className}"><div class="gfm-alert-title">${alert.icon}<span>${key[0]}${key.slice(1).toLowerCase()}</span></div><div class="gfm-alert-body">${body}</div></div>`;
    }
  );
}

// Resolve a posix path with `.`/`..` segments against an absolute base dir.
function resolvePosix(baseDir: string, rel: string): string {
  const out: string[] = [];
  for (const seg of `${baseDir}/${rel}`.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return "/" + out.join("/");
}

// Rewrite relative <img>/<source> srcs (and srcset) to verne-asset:// URLs so
// images alongside the markdown file load. Runs after sanitize — DOMPurify would
// otherwise strip the custom scheme. Absolute URLs (http:, data:, etc.) untouched.
function rewriteRelativeAssets(html: string, filePath?: string): string {
  if (!filePath) return html;
  const i = filePath.lastIndexOf("/");
  const baseDir = i <= 0 ? "/" : filePath.slice(0, i);
  const isAbsolute = (s: string) => /^[a-z][a-z0-9+.-]*:/i.test(s) || s.startsWith("//") || s.startsWith("#");
  const resolve = (raw: string): string => {
    const src = raw.trim();
    if (!src || isAbsolute(src)) return raw;
    return convertFileSrc(src.startsWith("/") ? src : resolvePosix(baseDir, src));
  };

  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  tpl.content.querySelectorAll<HTMLImageElement>("img[src], source[src]").forEach((el) => {
    el.setAttribute("src", resolve(el.getAttribute("src") ?? ""));
  });
  // srcset: rewrite each candidate's URL, preserve descriptors (e.g. "2x").
  tpl.content.querySelectorAll<HTMLImageElement>("img[srcset], source[srcset]").forEach((el) => {
    const next = (el.getAttribute("srcset") ?? "")
      .split(",")
      .map((c) => {
        const [url, ...desc] = c.trim().split(/\s+/);
        return url ? [resolve(url), ...desc].join(" ") : c.trim();
      })
      .join(", ");
    el.setAttribute("srcset", next);
  });
  return tpl.innerHTML;
}

let renderGen = 0;
async function render(content: string) {
  const gen = ++renderGen;
  // Raw HTML in the source is rendered (GitHub-style) but sanitized below before
  // it reaches v-html — strips scripts/event handlers while keeping inline tags.
  const md = new MarkdownIt({ html: true, linkify: true, typographer: true });
  const pendingBlocks: Array<{ placeholder: string; code: string; lang: string }> = [];

  md.renderer.rules.fence = (tokens, idx) => {
    const token = tokens[idx];
    const lang = token.info.trim().split(/\s+/)[0] ?? "";
    const placeholder = `__CODE_BLOCK_${idx}__`;
    pendingBlocks.push({ placeholder, code: token.content, lang });
    const displayName = lang ? (LANG_DISPLAY_NAMES[lang.toLowerCase()] ?? lang) : "";
    const label = displayName
      ? `<div class="code-label">${displayName}</div>`
      : "";
    const lineAttr = token.map ? ` data-line="${token.map[0]}"` : "";
    return `<div class="code-block-wrapper"${lineAttr}>${label}<pre class="code-block"><code>${placeholder}</code></pre></div>\n`;
  };

  // Task list support
  md.core.ruler.after("inline", "task-lists", (state) => {
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].type !== "inline") continue;
      const content = tokens[i].content;
      if (!/^\[([ xX])\]\s/.test(content)) continue;
      // Find parent list_item_open
      for (let j = i - 1; j >= 0; j--) {
        if (tokens[j].type === "list_item_open") {
          tokens[j].attrJoin("class", "task-list-item");
          break;
        }
        if (tokens[j].type === "list_item_close") break;
      }
      // Find parent bullet_list_open / ordered_list_open
      for (let j = i - 1; j >= 0; j--) {
        if (tokens[j].type === "bullet_list_open" || tokens[j].type === "ordered_list_open") {
          tokens[j].attrJoin("class", "task-list");
          break;
        }
        if (tokens[j].type === "bullet_list_close" || tokens[j].type === "ordered_list_close") break;
      }
      const checked = content[1] !== " ";
      const checkbox = checked
        ? `<input type="checkbox" checked disabled class="task-checkbox">`
        : `<input type="checkbox" disabled class="task-checkbox">`;
      tokens[i].content = content.replace(/^\[([ xX])\]\s/, "");
      tokens[i].children?.[0] && (tokens[i].children![0].content = tokens[i].children![0].content.replace(/^\[([ xX])\]\s/, ""));
      // Inject checkbox HTML before the inline token
      const checkboxToken = new state.Token("html_inline", "", 0);
      checkboxToken.content = checkbox;
      tokens[i].children?.unshift(checkboxToken);
    }
  });

  // Tag opening block tags with their source line so the toggle can carry the
  // scroll position. Skip blockquotes — processAlerts() matches a bare
  // `<blockquote>` and an attribute would break the alert rewrite.
  md.core.ruler.push("source-lines", (state) => {
    for (const token of state.tokens) {
      if (token.nesting === 1 && token.map && token.type !== "blockquote_open") {
        token.attrSet("data-line", String(token.map[0]));
      }
    }
  });

  // Sanitize the rendered markdown (which may now contain raw source HTML) before
  // splicing in our own trusted output (syntax-highlighted code, alert SVGs).
  // Keep target/rel so links can open externally; data-* carries source-line anchors.
  let html = DOMPurify.sanitize(md.render(content), {
    ADD_ATTR: ["target"],
  });

  await Promise.all(
    pendingBlocks.map(async ({ placeholder, code, lang }) => {
      const highlighted = await tokenizeCodeBlockToHtml(code, lang);
      html = html.replace(placeholder, highlighted);
    })
  );

  if (gen !== renderGen) return;
  renderedHtml.value = rewriteRelativeAssets(processAlerts(html), props.filePath);
  await nextTick();
  if (gen === renderGen) applyPendingScroll();
}

watch(() => props.content, render, { immediate: true });
</script>

<template>
  <!-- eslint-disable vue/no-v-html -- rendered HTML is sanitized via DOMPurify before assignment; code blocks escaped by tokenizeCodeBlockToHtml. -->
  <div ref="scroller" class="md-scroll">
    <div
      ref="root"
      class="md-preview outline-none"
      tabindex="-1"
      :style="{ '--preview-font': settings.editorFontFamily }"
      v-html="renderedHtml"
    />
  </div>
  <!-- eslint-enable vue/no-v-html -->
</template>

<style scoped>
.md-scroll {
  height: 100%;
  overflow-y: auto;
}

.md-preview {
  padding: 32px 40px;
  color: var(--foreground);
  font-size: 16px;
  line-height: 1.5;
  max-width: 800px;
  margin: 0 auto;
  word-wrap: break-word;
  /* Read-only document selection — overrides the global body user-select:none. */
  user-select: text;
  -webkit-user-select: text;
  cursor: auto;
}

/* Headings */
.md-preview :deep(h1),
.md-preview :deep(h2),
.md-preview :deep(h3),
.md-preview :deep(h4),
.md-preview :deep(h5),
.md-preview :deep(h6) {
  margin-top: 24px;
  margin-bottom: 16px;
  font-weight: 600;
  line-height: 1.25;
  color: var(--foreground);
}

.md-preview :deep(h1) {
  font-size: 2em;
  padding-bottom: 0.3em;
  border-bottom: 1px solid var(--border);
}

.md-preview :deep(h2) {
  font-size: 1.5em;
  padding-bottom: 0.3em;
  border-bottom: 1px solid var(--border);
}

.md-preview :deep(h3) { font-size: 1.25em; }
.md-preview :deep(h4) { font-size: 1em; }
.md-preview :deep(h5) { font-size: 0.875em; }
.md-preview :deep(h6) { font-size: 0.85em; color: var(--muted-foreground); }

.md-preview :deep(:first-child) { margin-top: 0 !important; }

/* Paragraphs */
.md-preview :deep(p) {
  margin-top: 0;
  margin-bottom: 16px;
}

/* Links */
.md-preview :deep(a) {
  color: var(--primary);
  text-decoration: none;
}
.md-preview :deep(a:hover) {
  text-decoration: underline;
}

/* Strong / Em / Del */
.md-preview :deep(strong) { font-weight: 600; }
.md-preview :deep(em) { font-style: italic; }
.md-preview :deep(del) { text-decoration: line-through; }

/* Lists */
.md-preview :deep(ul) {
  margin-top: 0;
  margin-bottom: 16px;
  padding-left: 2em;
  list-style: disc;
}

.md-preview :deep(ol) {
  margin-top: 0;
  margin-bottom: 16px;
  padding-left: 2em;
  list-style: decimal;
}

.md-preview :deep(li) {
  margin-top: 0.25em;
}

.md-preview :deep(li + li) {
  margin-top: 0.25em;
}

.md-preview :deep(li > p) {
  margin-top: 16px;
}

.md-preview :deep(li > p:first-child) {
  margin-top: 0;
}

/* Nested lists */
.md-preview :deep(ul ul),
.md-preview :deep(ul ol),
.md-preview :deep(ol ul),
.md-preview :deep(ol ol) {
  margin-top: 0;
  margin-bottom: 0;
}

/* Task lists */
.md-preview :deep(.task-list) {
  list-style: none;
  padding-left: 1.5em;
}

.md-preview :deep(.task-list-item) {
  position: relative;
}

.md-preview :deep(.task-checkbox) {
  margin: 0 0.35em 0 -1.4em;
  vertical-align: middle;
  pointer-events: none;
  accent-color: var(--primary);
}

/* Inline code */
.md-preview :deep(code) {
  background: var(--muted);
  padding: 0.2em 0.4em;
  border-radius: 6px;
  font-family: var(--preview-font, monospace);
  font-size: 85%;
}

/* Code blocks */
.md-preview :deep(.code-block-wrapper) {
  position: relative;
  margin-bottom: 16px;
}

.md-preview :deep(.code-label) {
  position: absolute;
  top: 0;
  right: 0;
  padding: 4px 12px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--muted-foreground);
  background: color-mix(in srgb, var(--muted) 60%, transparent 40%);
  border-bottom-left-radius: 6px;
  border-top-right-radius: 6px;
  font-family: var(--preview-font, monospace);
  user-select: none;
}

.md-preview :deep(pre) {
  background: var(--editor-bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 16px;
  overflow-x: auto;
  margin-bottom: 16px;
  font-family: var(--preview-font, monospace);
  font-size: 85%;
  line-height: 1.45;
}

.md-preview :deep(.code-block-wrapper pre) {
  margin-bottom: 0;
}

.md-preview :deep(pre code) {
  background: none;
  padding: 0;
  border-radius: 0;
  font-size: inherit;
  line-height: inherit;
  word-wrap: normal;
  white-space: pre;
}

/* Blockquotes */
.md-preview :deep(blockquote) {
  margin: 0 0 16px 0;
  padding: 0 1em;
  color: var(--muted-foreground);
  border-left: 0.25em solid var(--border);
}

.md-preview :deep(blockquote > :first-child) {
  margin-top: 0;
}

.md-preview :deep(blockquote > :last-child) {
  margin-bottom: 0;
}

/* Tables */
.md-preview :deep(table) {
  border-collapse: collapse;
  border-spacing: 0;
  width: auto;
  max-width: 100%;
  overflow: auto;
  margin-bottom: 16px;
  display: block;
}

.md-preview :deep(th),
.md-preview :deep(td) {
  border: 1px solid var(--border);
  padding: 6px 13px;
}

.md-preview :deep(th) {
  font-weight: 600;
  background: var(--muted);
}

/* Horizontal rules */
.md-preview :deep(hr) {
  height: 0.25em;
  padding: 0;
  margin: 24px 0;
  background-color: var(--border);
  border: 0;
}

/* Images */
.md-preview :deep(img) {
  max-width: 100%;
  border-style: none;
  box-sizing: content-box;
}

/* GFM Alert Callouts */
.md-preview :deep(.gfm-alert) {
  padding: 0 1em;
  margin-bottom: 16px;
  border-left: 0.25em solid;
  border-radius: 0;
}

.md-preview :deep(.gfm-alert-title) {
  display: flex;
  align-items: center;
  gap: 0.5em;
  font-weight: 600;
  margin-bottom: 4px;
  line-height: 1;
  padding-top: 0.75em;
}

.md-preview :deep(.gfm-alert-title svg) {
  flex-shrink: 0;
}

.md-preview :deep(.gfm-alert-body > :last-child) {
  margin-bottom: 0;
}

.md-preview :deep(.gfm-alert-body) {
  padding-bottom: 0.75em;
}

.md-preview :deep(.alert-note) { border-left-color: #4493f8; }
.md-preview :deep(.alert-note .gfm-alert-title) { color: #4493f8; }

.md-preview :deep(.alert-tip) { border-left-color: #3fb950; }
.md-preview :deep(.alert-tip .gfm-alert-title) { color: #3fb950; }

.md-preview :deep(.alert-important) { border-left-color: #ab7df8; }
.md-preview :deep(.alert-important .gfm-alert-title) { color: #ab7df8; }

.md-preview :deep(.alert-warning) { border-left-color: #d29922; }
.md-preview :deep(.alert-warning .gfm-alert-title) { color: #d29922; }

.md-preview :deep(.alert-caution) { border-left-color: #f85149; }
.md-preview :deep(.alert-caution .gfm-alert-title) { color: #f85149; }
</style>
