<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, onBeforeUnmount, shallowRef, nextTick, computed } from "vue";
import { listen, showSaveDialog, type UnlistenFn } from "@/platform";
import { useRpc } from "@/composables/useRpc";
import { useWorkspaceStore } from "@/stores/workspace";
import { addToAgent } from "@/composables/useAddToAgent";
import {
  Empty,
  EmptyContent,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "./ui/empty";
import { useSettings } from "@/composables/useSettings";
import { useTheme } from "@/composables/useTheme";
import { AlertTriangle } from "@lucide/vue";
import { Button } from "./ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "./ui/context-menu";
import * as monaco from "monaco-editor";
import { ensureMonaco } from "@/lib/monacoBootstrap";
import { ensureGrammar } from "@/lib/textmate";
import { detectMonacoLanguage } from "@/lib/languageDetect";
import {
  analyzeEditorContent,
  formatApproxFileSize,
  MAX_SAFE_TOKENIZATION_LINE_LENGTH,
  type EditorContentProfile,
} from "@/lib/editorLargeFile";
import { emmetHTML, emmetCSS } from "emmet-monaco-es";
import { getOrStartClient, LSP_LANGUAGE_MAP, stopClient } from "@/composables/useLanguageClient";
import MarkdownPreview from "./MarkdownPreview.vue";
import MarkdownToolbar from "./MarkdownToolbar.vue";
import { runMarkdownAction, isMarkdownPath } from "@/composables/useMarkdownFormatting";
import { listContinuation, type FormatAction } from "@/lib/markdownFormat";
import { joinFrontmatter, splitFrontmatter, titleFrontmatter } from "@/lib/frontmatter";

// ---- One-time Monaco bootstrap ----

// From Volar's vue-language-configuration.json — extracted so comment action can re-apply with different tokens
const vueBaseConf: Omit<monaco.languages.LanguageConfiguration, "comments"> = {
  brackets: [
    ["<!--", "-->"],
    ["{", "}"],
    ["(", ")"],
  ],
  autoClosingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: "'", close: "'" },
    { open: '"', close: '"' },
    { open: "<!--", close: "-->", notIn: ["comment", "string"] },
    { open: "`", close: "`", notIn: ["string", "comment"] },
    { open: "/**", close: " */", notIn: ["string"] },
  ],
  surroundingPairs: [
    { open: "'", close: "'" },
    { open: '"', close: '"' },
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: "<", close: ">" },
    { open: "`", close: "`" },
  ],
  colorizedBracketPairs: [
    ["{", "}"],
    ["[", "]"],
    ["(", ")"],
  ],
  folding: {
    markers: {
      start: /^\s*<!--\s*#region\b.*-->/,
      end: /^\s*<!--\s*#endregion\b.*-->/,
    },
  },
  wordPattern: /(-?\d*\.\d\w*)|([^`~!@$^&*()=+\[{\]}\\\|;:'",.< >\/\s]+)/,
  onEnterRules: [
    {
      beforeText:
        /<(?!(?:area|base|br|col|embed|hr|img|input|keygen|link|menuitem|meta|param|source|track|wbr|script|style))([_:\w][_:\w-.\d]*)(?:(?:[^'"/>]|"[^"]*"|'[^']*')*?(?!\/)>)[^<]*$/i,
      afterText: /^<\/([_:\w][_:\w-.\d]*)\s*>/i,
      action: { indentAction: monaco.languages.IndentAction.IndentOutdent },
    },
    {
      beforeText:
        /<(?!(?:area|base|br|col|embed|hr|img|input|keygen|link|menuitem|meta|param|source|track|wbr|script|style))([_:\w][_:\w-.\d]*)(?:(?:[^'"/>]|"[^"]*"|'[^']*')*?(?!\/)>)[^<]*$/i,
      action: { indentAction: monaco.languages.IndentAction.Indent },
    },
  ],
  indentationRules: {
    increaseIndentPattern: new RegExp(
      String.raw`<(?!\?|(?:area|base|br|col|frame|hr|html|img|input|keygen|link|menuitem|meta|param|source|track|wbr|script|style)\b|[^>]*\/)[-_.A-Za-z0-9]+(?=\s|>)\b[^>]*>|<!--(?!.*-->)|\{[^}"']*$`,
    ),
    decreaseIndentPattern: /^\s*(<\/(?!html)[-_.A-Za-z0-9]+\b[^>]*>|-->|\})/,
  },
};

function setVueComments(comments: monaco.languages.CommentRule) {
  monaco.languages.setLanguageConfiguration("vue", { ...vueBaseConf, comments });
}

// Detect which SFC section a line falls in and return comment tokens
function vueSectionComment(
  model: monaco.editor.ITextModel,
  lineNumber: number,
): monaco.languages.CommentRule {
  for (let i = lineNumber; i >= 1; i--) {
    const text = model.getLineContent(i).trim();
    if (/^<script[\s>]/.test(text)) return { lineComment: "//", blockComment: ["/*", "*/"] };
    if (/^<style[\s>]/.test(text)) return { blockComment: ["/*", "*/"] };
    if (/^<template[\s>]/.test(text)) return { blockComment: ["<!--", "-->"] };
    if (/^<\/(?:script|style|template)>/.test(text)) break;
  }
  return { blockComment: ["<!--", "-->"] };
}

// Auto-close HTML/Vue tags when typing ">"
const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);
const AUTO_CLOSE_TAG_LANGS = new Set(["html", "vue"]);

function setupAutoCloseTags(ed: monaco.editor.IStandaloneCodeEditor): monaco.IDisposable {
  return ed.onDidChangeModelContent((e) => {
    const model = ed.getModel();
    if (!model || !AUTO_CLOSE_TAG_LANGS.has(model.getLanguageId())) return;
    if (e.isUndoing || e.isRedoing) return;

    for (const change of e.changes) {
      if (change.text !== ">") continue;

      const pos = model.getPositionAt(change.rangeOffset + change.text.length);
      const lineContent = model.getLineContent(pos.lineNumber);
      // pos.column - 1 includes the typed ">", so strip it
      const before = lineContent.substring(0, pos.column - 2);

      // Skip self-closing tags (/>), closing tags (</), comments (--)
      if (/\/$/.test(before) || /--$/.test(before)) continue;

      const tagMatch = before.match(/<([a-zA-Z][\w.-]*)\b[^>]*$/);
      if (!tagMatch) continue;

      const tagName = tagMatch[1];
      if (VOID_ELEMENTS.has(tagName.toLowerCase())) continue;

      const closeTag = `</${tagName}>`;
      ed.executeEdits("auto-close-tag", [{
        range: new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column),
        text: closeTag,
        forceMoveMarkers: false,
      }]);
      // Keep cursor between tags
      ed.setPosition(pos);
      break;
    }
  });
}

// Register opener for cross-file definition navigation (go-to-definition, etc.).
// gotoLocation.multipleDefinitions='goto' in editor options ensures Monaco calls
// _openReference → openCodeEditor instead of showing a peek widget.
let _openerRegistered = false;
function registerDefinitionOpener() {
  if (_openerRegistered) return;
  _openerRegistered = true;
  monaco.editor.registerEditorOpener({
    openCodeEditor(_source, resource, selectionOrPosition) {
      const filePath = resource.path;
      let position: { line: number; column: number } | undefined;
      if (selectionOrPosition) {
        if ("startLineNumber" in selectionOrPosition) {
          position = {
            line: selectionOrPosition.startLineNumber,
            column: selectionOrPosition.startColumn,
          };
        } else {
          position = { line: selectionOrPosition.lineNumber, column: selectionOrPosition.column };
        }
      }
      window.dispatchEvent(
        new CustomEvent("open-file-tab", {
          detail: { path: filePath, position },
        }),
      );
      return true;
    },
  });
}

let editorBootstrapPromise: Promise<void> | null = null;
function ensureEditorBootstrap(themeSpec: any, themeName: string) {
  if (!editorBootstrapPromise) {
    editorBootstrapPromise = (async () => {
      await ensureMonaco(themeSpec, themeName);
      setVueComments({ blockComment: ["<!--", "-->"] });
      emmetHTML(monaco, ["html", "vue"], { tokenizer: "standard" });
      emmetCSS(monaco, ["css", "tailwindcss"], { tokenizer: "standard" });
      registerDefinitionOpener();
    })();
  }
  return editorBootstrapPromise;
}


// ---- Component ----

const props = withDefaults(
  defineProps<{
    filePath: string;
    rootDir?: string;
    untitled?: boolean;
    initialScrollTop?: number;
    initialCursorLine?: number;
    initialCursorColumn?: number;
    positionVersion?: number;
    markdownPreview?: boolean;
    svgPreview?: boolean;
    // Per-instance editor option overrides (used by notes, which keep their
    // own prefs). When undefined, fall back to the global editor settings.
    // Boolean props MUST default to undefined — Vue's boolean casting otherwise
    // turns an absent prop into `false`, which would defeat the `?? global` fallback
    // in resolved*() and pin file editors to false regardless of the setting.
    wordWrap?: boolean;
    lineNumbers?: boolean;
    minimap?: boolean;
    // Per-instance auto-save override. Notes auto-save
    // regardless of the global `autoSave` setting. Undefined → global setting.
    autoSave?: boolean;
    // Hide YAML frontmatter from Monaco/preview while preserving it on disk.
    preserveFrontmatter?: boolean;
    // Used to lazily migrate a legacy document that has no frontmatter yet.
    frontmatterTitle?: string;
  }>(),
  { wordWrap: undefined, lineNumbers: undefined, minimap: undefined, autoSave: undefined },
);

function resolvedWordWrap(): boolean {
  return props.wordWrap ?? !!getSettingForLanguage("editorWordWrap", currentLanguage.value);
}
function resolvedLineNumbers(): boolean {
  return props.lineNumbers ?? settings.value.editorLineNumbers;
}
function resolvedMinimap(): boolean {
  return props.minimap ?? settings.value.editorMinimap;
}
const emit = defineEmits<{
  dirty: [isDirty: boolean];
  saved: [filePath: string];
  close: [];
  viewState: [state: { scrollTop: number; cursorLine: number; cursorColumn: number }];
  /** Live editor content on every change — used by the notes panel to derive
   *  the title from the first heading without waiting for a save. Optional; most
   *  consumers ignore it. */
  change: [content: string];
}>();

const containerRef = ref<HTMLElement | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);
const stale = ref(false);
const deleted = ref(false);
const largeFileMessage = ref<string | null>(null);

const editor = shallowRef<monaco.editor.IStandaloneCodeEditor | null>(null);
const currentLanguage = ref("plaintext");
let baseContent = "";
let frontmatterPrefix = "";
let currentMtime = 0;
let fileWatchUnlisten: UnlistenFn | null = null;
let watchedPath: string | null = null;
let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
let shadowTimer: ReturnType<typeof setTimeout> | null = null;
let isDirty = false;
let currentFilePath: string = ""; // tracks the file we're actually editing (not props which update early)
const currentFilePathRef = ref(currentFilePath);
let currentContentProfile: EditorContentProfile | null = null;
let loadGeneration = 0;
let resolveMounted!: () => void;
const mountedPromise = new Promise<void>((resolve) => {
  resolveMounted = resolve;
});
// In-memory dirty content cache for files outside rootDir (shadow tree can't handle absolute paths)
// Capped at 50 entries to prevent unbounded memory growth
const DIRTY_CACHE_MAX = 50;
const dirtyContentCache = new Map<string, string>();
const shadowPersistedHashes = new Map<string, number>();

function contentHash(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

function rememberShadowContent(path: string, content: string) {
  shadowPersistedHashes.set(path, contentHash(content));
}

function forgetShadowContent(path: string) {
  shadowPersistedHashes.delete(path);
}

function hasShadow(path: string): boolean {
  return shadowPersistedHashes.has(path);
}

function clearModelMarkers(model: monaco.editor.ITextModel | null | undefined) {
  if (!model) return;
  const owners = new Set(
    monaco.editor.getModelMarkers({ resource: model.uri }).map(marker => marker.owner),
  );
  for (const owner of ["lsp", "typescript", "javascript", "json", "html", "css"]) {
    owners.add(owner);
  }
  for (const owner of owners) {
    monaco.editor.setModelMarkers(model, owner, []);
  }
}

function syncShadowTracking(path: string, content: string, base: string) {
  if (content === base) {
    forgetShadowContent(path);
    return;
  }
  rememberShadowContent(path, content);
}

function persistProjectShadow(path: string, content: string, options?: { retainHash?: boolean }) {
  if (!props.rootDir || isExternalFile(path)) return;
  const retainHash = options?.retainHash ?? true;
  const nextHash = contentHash(content);
  if (shadowPersistedHashes.get(path) === nextHash) {
    if (!retainHash) forgetShadowContent(path);
    return;
  }
  useRpc()
    .request.shadowCommit({
      dir: props.rootDir,
      relPath: relPathFor(path),
      content,
    })
    .then(() => {
      if (retainHash) shadowPersistedHashes.set(path, nextHash);
      else forgetShadowContent(path);
    })
    .catch(() => {});
}

function dirtyContentCacheSet(key: string, value: string) {
  dirtyContentCache.set(key, value);
  // Evict oldest entries (Map preserves insertion order)
  if (dirtyContentCache.size > DIRTY_CACHE_MAX) {
    const first = dirtyContentCache.keys().next().value;
    if (first !== undefined) dirtyContentCache.delete(first);
  }
}

const previewContent = ref("");
const previewRef = ref<InstanceType<typeof MarkdownPreview> | null>(null);
// 0-based source line the preview should open at, carried from the editor.
const previewInitialLine = ref(0);
// When the editor was scrolled to the bottom, snap the preview to its bottom
// too (the views differ in height, so line-mapping can't reach it).
const previewInitialBottom = ref(false);

const showPreview = computed(() => !!props.markdownPreview);
const showMarkdownToolbar = computed(() => isMarkdownPath(props.filePath) && !showPreview.value);

let mdContextKey: monaco.editor.IContextKey<boolean> | null = null;
let mdEnterDisposable: monaco.IDisposable | null = null;

function onFormatAction(action: FormatAction) {
  if (editor.value && isMarkdownPath(props.filePath)) runMarkdownAction(editor.value, action);
}

// GitHub-style list continuation: Enter on a list/quote line inserts the next
// marker (numbers increment); Enter on an empty item clears it to exit the list.
function handleMarkdownEnter(ed: monaco.editor.IStandaloneCodeEditor, e: monaco.IKeyboardEvent) {
  if (e.keyCode !== monaco.KeyCode.Enter) return;
  if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
  if (!isMarkdownPath(props.filePath)) return;
  const model = ed.getModel();
  const sel = ed.getSelection();
  if (!model || !sel || !sel.isEmpty()) return;
  // Don't hijack Enter while the suggest/accept widget is open.
  if (ed.getDomNode()?.querySelector(".suggest-widget.visible")) return;
  const lineNumber = sel.positionLineNumber;
  const res = listContinuation(model.getLineContent(lineNumber));
  if (!res) return;
  e.preventDefault();
  e.stopPropagation();
  ed.pushUndoStop();
  if (res.kind === "exit") {
    const range = new monaco.Range(lineNumber, 1, lineNumber, model.getLineMaxColumn(lineNumber));
    ed.executeEdits("md-list", [{ range, text: "" }]);
  } else {
    ed.executeEdits("md-list", [{ range: sel, text: "\n" + res.marker, forceMoveMarkers: true }]);
  }
  ed.pushUndoStop();
}

function registerMarkdownKeybindings(ed: monaco.editor.IStandaloneCodeEditor) {
  mdContextKey = ed.createContextKey<boolean>("verneIsMarkdown", isMarkdownPath(props.filePath));
  const fmt = (action: FormatAction) => () => {
    if (isMarkdownPath(props.filePath)) runMarkdownAction(ed, action);
  };
  ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyB, fmt("bold"), "verneIsMarkdown");
  ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyI, fmt("italic"), "verneIsMarkdown");
  ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyE, fmt("code"), "verneIsMarkdown");
  ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, fmt("link"), "verneIsMarkdown");
  mdEnterDisposable?.dispose();
  mdEnterDisposable = ed.onKeyDown((e) => handleMarkdownEnter(ed, e));
}

const showSvgPreview = computed(() => !!props.svgPreview);
const svgPreviewSrc = ref<string | null>(null);
let svgPreviewUrl: string | null = null;

function setSvgPreviewContent(content: string | null) {
  if (svgPreviewUrl) URL.revokeObjectURL(svgPreviewUrl);
  svgPreviewUrl = null;
  svgPreviewSrc.value = null;
  if (content === null) return;
  svgPreviewUrl = URL.createObjectURL(new Blob([content], { type: "image/svg+xml" }));
  svgPreviewSrc.value = svgPreviewUrl;
}

// Populate the preview when it's toggled on for an already-loaded file. Skip
// while a file load is in flight: the editor still holds the *previous* file's
// text (Monaco's model swaps only after the async read), so grabbing it here
// would briefly render the wrong file. loadFile() sets previewContent once the
// new content is ready. flush:"post" so loadFile's pre-flush clear wins at mount.
// Toggle handling. Runs pre-DOM-flush so the outgoing view is still mounted
// when we read its position, and so the preview mounts with fresh content (not
// the previous session's) — letting it apply the carried scroll on first render.
// Source lines align because the editor model and preview share the same body
// text (frontmatter is split off), so markdown source line == model line − 1.
// Skipped while a load is in flight: the model still holds the previous file's
// text; loadFile() sets previewContent once the new content is ready.
watch(() => props.markdownPreview, (v) => {
  if (v) {
    // A file switch also flips this true (preview is the default for md). That's
    // not a real toggle — the editor is still loading/unmeasured — so don't carry
    // a position; loadFile() sets previewContent and the preview opens at the top.
    if (loading.value) {
      previewInitialLine.value = 0;
      previewInitialBottom.value = false;
      return;
    }
    previewContent.value = editor.value?.getValue() ?? "";
    // → preview: snap to the bottom if the editor is at the bottom, else open
    // at the editor's top visible line.
    const e = editor.value;
    const scrollable = !!e && e.getScrollHeight() - e.getLayoutInfo().height > 1;
    previewInitialBottom.value = scrollable
      && e!.getScrollTop() + e!.getLayoutInfo().height >= e!.getScrollHeight() - 2;
    const top = e?.getVisibleRanges()[0]?.startLineNumber ?? 1;
    previewInitialLine.value = Math.max(0, top - 1);
  } else {
    // → editor: snap to the bottom if the preview is, else reveal the preview's
    // top line near the top of the viewport.
    const preview = previewRef.value;
    const line = (preview?.topLine() ?? 0) + 1;
    const bottom = preview?.atBottom() ?? false;
    nextTick(() => {
      const e = editor.value;
      if (!e) return;
      if (bottom) e.setScrollTop(e.getScrollHeight());
      else e.revealLineNearTop(line, monaco.editor.ScrollType.Immediate);
    });
  }
});

// A new file is a fresh document — never carry the previous file's scroll.
// Runs pre-DOM-flush so the keyed preview remounts at the top.
watch(() => props.filePath, () => {
  previewInitialLine.value = 0;
  previewInitialBottom.value = false;
});
watch(() => props.svgPreview, (v) => {
  setSvgPreviewContent(v ? editor.value?.getValue() ?? "" : null);
});

function onClearDirtyCache(e: Event) {
  const path = (e as CustomEvent).detail;
  dirtyContentCache.delete(path);
  forgetShadowContent(path);
  if (currentFilePath === path) clearModelMarkers(editor.value?.getModel());
  // Reset local dirty flag so loadFile flush won't re-cache
  if (currentFilePath === path) isDirty = false;
}

function onExternalDelete(e: Event) {
  if ((e as CustomEvent).detail === props.filePath) {
    deleted.value = true;
  }
}
let changeDisposable: monaco.IDisposable | null = null;
let autoCloseTagDisposable: monaco.IDisposable | null = null;
let scrollDisposable: monaco.IDisposable | null = null;
let cursorDisposable: monaco.IDisposable | null = null;
let selectionDisposable: monaco.IDisposable | null = null;
let hoverObserver: MutationObserver | null = null;
const hasSelection = ref(false);

// We own the editor's layout, not Monaco's automaticLayout (unreliable under
// WKWebView — see editorOptions). A ResizeObserver on the container relayouts
// on every size change; scheduleLayout coalesces to one call per frame and is
// also fired explicitly after create / model swap so the editor never paints
// blank from a stale or mid-layout measurement.
let resizeObserver: ResizeObserver | null = null;
let layoutRaf = 0;
let layoutRetryRaf = 0;
let layoutRetryUntil = 0;
function forceEditorLayout(): boolean {
  const ed = editor.value;
  const el = containerRef.value;
  if (!ed || !el) return false;
  const rect = el.getBoundingClientRect();
  const width = Math.floor(rect.width);
  const height = Math.floor(rect.height);
  if (width <= 0 || height <= 0) return false;
  ed.layout({ width, height });
  (ed as any).render?.(true);
  return true;
}
function scheduleLayout() {
  if (layoutRaf) return;
  layoutRaf = requestAnimationFrame(() => {
    layoutRaf = 0;
    forceEditorLayout();
  });
}
function ensureEditorLaidOut(durationMs = 600) {
  layoutRetryUntil = Math.max(layoutRetryUntil, performance.now() + durationMs);
  if (layoutRetryRaf) return;
  const tick = () => {
    layoutRetryRaf = 0;
    forceEditorLayout();
    if (performance.now() >= layoutRetryUntil) return;
    layoutRetryRaf = requestAnimationFrame(tick);
  };
  layoutRetryRaf = requestAnimationFrame(tick);
}
function attachLayoutObserver() {
  if (resizeObserver || !containerRef.value) return;
  resizeObserver = new ResizeObserver(() => ensureEditorLaidOut(250));
  resizeObserver.observe(containerRef.value);
}

async function waitForEditorContainer(isCurrentLoad: () => boolean): Promise<HTMLElement | null> {
  await mountedPromise;
  if (!isCurrentLoad()) return null;
  for (let i = 0; i < 30; i++) {
    await nextTick();
    if (!isCurrentLoad()) return null;
    const el = containerRef.value;
    if (el && el.isConnected) return el;
    await new Promise(requestAnimationFrame);
    if (!isCurrentLoad()) return null;
  }
  return null;
}

function editorTrigger(action: string) {
  editor.value?.trigger("menu", action, null);
}
function ctxCut() { editorTrigger("editor.action.clipboardCutAction"); }
function ctxCopy() { editorTrigger("editor.action.clipboardCopyAction"); }
function ctxPaste() { editorTrigger("editor.action.clipboardPasteAction"); }
function ctxCopyPath() {
  navigator.clipboard.writeText(currentFilePath || props.filePath);
}
function ctxCopyRelativePath() {
  navigator.clipboard.writeText(relPath());
}
function ctxReveal() {
  useRpc().request.revealInFinder({ path: currentFilePath || props.filePath });
}

// reka's ContextMenuItem @select fires twice on some pointer gestures (its
// pointerup synthesizes a click on top of the native one). Guard so we only
// inject once per invocation. Set synchronously before the await so the
// back-to-back second call is dropped.
let lastAddToAgentAt = 0;

// Build a `path:line` / `path:start-end` ref for the selection (or current
// line) and inject it into the active agent's terminal.
async function ctxAddToAgent() {
  const now = Date.now();
  if (now - lastAddToAgentAt < 500) return;
  lastAddToAgentAt = now;

  const ed = editor.value;
  if (!ed) return;
  const sel = ed.getSelection();
  let lineSpec: string;
  if (sel && !sel.isEmpty()) {
    let endLine = sel.endLineNumber;
    // A selection ending at column 1 doesn't actually cover that line.
    if (sel.endColumn === 1 && endLine > sel.startLineNumber) endLine -= 1;
    lineSpec =
      endLine > sel.startLineNumber ? `${sel.startLineNumber}-${endLine}` : `${sel.startLineNumber}`;
  } else {
    lineSpec = `${ed.getPosition()?.lineNumber ?? 1}`;
  }
  await addToAgent(`${relPath()}:${lineSpec}`);
}

const store = useWorkspaceStore();
const { settings, getSettingForLanguage } = useSettings();
const { activeThemeName, getActiveThemeSpec } = useTheme();

// Markdown files show the formatting toolbar above the editor; give the text a
// bigger top gap (≈ one text line) so it isn't cramped against the bar.
function editorPadding(): { top: number; bottom: number } {
  const top = isMarkdownPath(props.filePath) ? Math.round(settings.value.editorFontSize * 1.4) : 8;
  return { top, bottom: 8 };
}

function editorOptions(): monaco.editor.IStandaloneEditorConstructionOptions {
  const fontSize = settings.value.editorFontSize;
  const lh = settings.value.editorLineHeight;
  const reduced = !!currentContentProfile?.shouldDisableLanguageFeatures;
  return {
    theme: activeThemeName.value,
    fontSize,
    lineHeight: lh === 0 ? Math.round(fontSize * 1.5) : Math.max(lh, fontSize),
    fontFamily: settings.value.editorFontFamily,
    fontWeight: settings.value.editorFontWeight,
    fontLigatures: settings.value.editorFontLigatures,
    disableMonospaceOptimizations: settings.value.editorFontLigatures,
    wordWrap: reduced ? "off" : resolvedWordWrap() ? "on" : "off",
    lineNumbers: resolvedLineNumbers() ? "on" : "off",
    minimap: {
      enabled: !reduced && resolvedMinimap(),
      renderCharacters: settings.value.editorMinimapRenderCharacters,
      scale: settings.value.editorMinimapScale,
      showSlider: settings.value.editorMinimapShowSlider,
    },
    scrollBeyondLastLine: false,
    renderLineHighlight: "all",
    cursorBlinking: "smooth",
    padding: editorPadding(),
    folding: !reduced,
    // Layout is owned explicitly via our own ResizeObserver (see attachLayoutObserver).
    // Monaco's built-in automaticLayout ResizeObserver is unreliable under WKWebView
    // and can leave a freshly-created / model-swapped editor blank.
    automaticLayout: false,
    tabSize: getSettingForLanguage("editorTabSize", currentLanguage.value),
    insertSpaces: getSettingForLanguage("editorInsertSpaces", currentLanguage.value),
    scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
    tabCompletion: "onlySnippets",
    contextmenu: false,
    multiCursorModifier: settings.value.editorMultiCursorModifier,
    stickyScroll: { enabled: !reduced && settings.value.editorStickyScroll },
    ...(reduced ? { codeLens: false, wordBasedSuggestions: "off" as const } : {}),
    maxTokenizationLineLength: MAX_SAFE_TOKENIZATION_LINE_LENGTH,
    stopRenderingLineAfter: MAX_SAFE_TOKENIZATION_LINE_LENGTH,
    gotoLocation: {
      multiple: "goto",
      multipleDefinitions: "goto",
      multipleTypeDefinitions: "goto",
      multipleDeclarations: "goto",
      multipleImplementations: "goto",
      multipleReferences: "goto",
    },
  };
}

function largeFileEditorOptions(): monaco.editor.IEditorOptions {
  const reduced = !!currentContentProfile?.shouldDisableLanguageFeatures;
  return {
    folding: !reduced,
    wordWrap: reduced ? "off" : resolvedWordWrap() ? "on" : "off",
    minimap: {
      enabled: !reduced && resolvedMinimap(),
      renderCharacters: settings.value.editorMinimapRenderCharacters,
      scale: settings.value.editorMinimapScale,
      showSlider: settings.value.editorMinimapShowSlider,
    },
    stickyScroll: { enabled: !reduced && settings.value.editorStickyScroll },
    stopRenderingLineAfter: MAX_SAFE_TOKENIZATION_LINE_LENGTH,
    ...(reduced ? { codeLens: false, wordBasedSuggestions: "off" as const } : {}),
  };
}

function largeFileStatus(profile: EditorContentProfile): string | null {
  if (!profile.shouldDisableLanguageFeatures) return null;
  const parts = [`${formatApproxFileSize(profile.length)}`];
  if (profile.hasLongLine) {
    parts.push(`longest line ${formatApproxFileSize(profile.maxLineLength)}`);
  }
  return `Large File Mode: ${parts.join(", ")}. Syntax and language features are reduced.`;
}

function setDirty(dirty: boolean) {
  if (isDirty === dirty) return;
  isDirty = dirty;
  emit("dirty", dirty);
}

function relPath(): string {
  return relPathFor(currentFilePath || props.filePath);
}

async function save() {
  if (!editor.value || !isDirty) return;
  if (props.untitled) {
    await saveAs();
    return;
  }
  if (stale.value) return; // conflict — user must choose Reload from disk or Keep my changes first

  // Check mtime before writing — watcher event may not have arrived yet
  try {
    const r = await useRpc().request.getFileMtime({ path: currentFilePath || props.filePath });
    if (r.mtime > currentMtime) {
      stale.value = true;
      return;
    }
  } catch {
    // File may have been deleted — let writeFile handle it
  }

  const content = editor.value.getValue();
  const diskContent = props.preserveFrontmatter
    ? joinFrontmatter(frontmatterPrefix, content)
    : content;
  try {
    const filePath = currentFilePath || props.filePath;
    if (shadowTimer) {
      clearTimeout(shadowTimer);
      shadowTimer = null;
    }
    const result = await useRpc().request.writeFile({ path: filePath, content: diskContent });
    currentMtime = result.mtime;
    baseContent = content;
    stale.value = false;
    setDirty(false);
    // Clear dirty state
    dirtyContentCache.delete(filePath);
    if (props.rootDir && !isExternalFile(filePath)) {
      await useRpc()
        .request.shadowOnSaved({ dir: props.rootDir, relPath: relPathFor(filePath), content });
      forgetShadowContent(filePath);
    }
  } catch (e: any) {
    console.error("Failed to save:", e);
  }
}

defineExpose({ save });

async function saveAs() {
  if (!editor.value) return;
  const filePath = await showSaveDialog({
    defaultPath: props.rootDir,
  });
  if (!filePath) return;
  const content = editor.value.getValue();
  const diskContent = props.preserveFrontmatter
    ? joinFrontmatter(frontmatterPrefix, content)
    : content;
  try {
    await useRpc().request.writeFile({ path: filePath, content: diskContent });
    baseContent = content;
    setDirty(false);
    forgetShadowContent(filePath);
    emit("saved", filePath);
  } catch (e: any) {
    console.error("Failed to save:", e);
  }
}

function scheduleAutoSave() {
  if (!(props.autoSave ?? settings.value.autoSave)) return;
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => save(), 1000);
}

function relPathFor(absPath: string): string {
  if (!props.rootDir) return absPath;
  return absPath.startsWith(props.rootDir + "/")
    ? absPath.slice(props.rootDir.length + 1)
    : absPath;
}

function isExternalFile(absPath: string): boolean {
  return !props.rootDir || !absPath.startsWith(props.rootDir + "/");
}

async function loadFile(filePath: string) {
  const generation = ++loadGeneration;
  const isCurrentLoad = () => generation === loadGeneration;
  // Hot path guardrail: switching tabs must reuse editor bootstrap, not redo it.
  // Flush dirty content for previous file before switching
  if (shadowTimer) clearTimeout(shadowTimer);
  if (isDirty && editor.value && currentFilePath) {
    const content = editor.value.getValue();
    if (isExternalFile(currentFilePath)) {
      dirtyContentCacheSet(currentFilePath, content);
    } else if (props.rootDir) {
      persistProjectShadow(currentFilePath, content, { retainHash: false });
    }
  } else if (currentFilePath && !isExternalFile(currentFilePath)) {
    forgetShadowContent(currentFilePath);
  }
  currentFilePath = filePath;
  currentFilePathRef.value = filePath;

  loading.value = true;
  error.value = null;
  stale.value = false;
  deleted.value = false;
  largeFileMessage.value = null;
  currentContentProfile = null;
  setDirty(false);
  // Clear the previous file's preview now — the instance is reused across file
  // switches, so without this the old file's rendered preview lingers (and the
  // async re-render keeps it on screen) until the new file finishes loading.
  previewContent.value = "";
  // Stop watching previous file
  if (fileWatchUnlisten) {
    fileWatchUnlisten();
    fileWatchUnlisten = null;
  }
  if (watchedPath) {
    useRpc()
      .request.unwatchFile({ path: watchedPath })
      .catch(() => {});
    watchedPath = null;
  }
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  autoCloseTagDisposable?.dispose();
  autoCloseTagDisposable = null;
  changeDisposable?.dispose();
  changeDisposable = null;

  let result, mtimeResult;
  try {
    const rpc = useRpc();
    [result, mtimeResult] = await Promise.all([
      rpc.request.readFile({ path: filePath }),
      rpc.request.getFileMtime({ path: filePath }),
    ]);
  } catch (e: any) {
    if (!isCurrentLoad()) return;
    const msg: string = e.message || e.toString?.() || "";
    if (msg.includes("No such file") || msg.includes("not found") || msg.includes("os error 2")) {
      deleted.value = true;
    } else {
      error.value = msg || "Failed to read file";
    }
    loading.value = false;
    return;
  }
  if (!isCurrentLoad()) return;

  const parsed = props.preserveFrontmatter
    ? splitFrontmatter(result.content)
    : { prefix: "", body: result.content };
  frontmatterPrefix = parsed.prefix
    || (props.preserveFrontmatter && props.frontmatterTitle
      ? titleFrontmatter(props.frontmatterTitle)
      : "");
  baseContent = parsed.body;
  currentMtime = mtimeResult.mtime;
  const detectedLanguage = detectMonacoLanguage(filePath);

  // Check for dirty content (in-memory cache for external files, shadow for project files)
  let editorContent = baseContent;
  if (isExternalFile(filePath)) {
    const cached = dirtyContentCache.get(filePath);
    if (cached !== undefined && cached !== baseContent) {
      editorContent = cached;
    }
  } else if (props.rootDir) {
    try {
      const shadow = await useRpc().request.shadowReadWithBaseline({
        dir: props.rootDir,
        relPath: relPath(),
      });
      if (shadow && shadow.content !== baseContent) {
        const diskHash = await sha256Hex(baseContent);
        if (shadow.baselineHash !== diskHash) {
          // Drift: disk has moved since shadow was recorded.
          stale.value = true;
        }
        editorContent = shadow.content;
      }
    } catch {}
  }
  if (!isExternalFile(filePath)) {
    syncShadowTracking(filePath, editorContent, baseContent);
  }

  const profile = analyzeEditorContent(editorContent);
  currentContentProfile = profile;
  largeFileMessage.value = largeFileStatus(profile);
  const language = profile.shouldOpenAsPlaintext ? "plaintext" : detectedLanguage;
  currentLanguage.value = language;

  await ensureEditorBootstrap(getActiveThemeSpec(), activeThemeName.value);
  if (!isCurrentLoad()) return;
  if (!profile.shouldDisableLanguageFeatures) {
    await ensureGrammar(language);
    if (!isCurrentLoad()) return;
  }

  const container = await waitForEditorContainer(isCurrentLoad);
  if (!isCurrentLoad() || !container) {
    return;
  }

  const uri = monaco.Uri.file(filePath);

  if (editor.value) {
    // Same-file reloads must not dispose the model currently attached to Monaco.
    // WebKit can leave the editor blank if it paints while the editor owns a
    // disposed model, so update that model in place.
    const oldModel = editor.value.getModel();
    if (oldModel?.uri.toString() === uri.toString()) {
      monaco.editor.setModelLanguage(oldModel, language);
      clearModelMarkers(oldModel);
      if (oldModel.getValue() !== editorContent) {
        oldModel.pushEditOperations(
          [],
          [{ range: oldModel.getFullModelRange(), text: editorContent }],
          () => null,
        );
      }
    } else {
      const existingModel = monaco.editor.getModel(uri);
      if (existingModel) existingModel.dispose();
      const newModel = monaco.editor.createModel(editorContent, language, uri);
      clearModelMarkers(newModel);
      editor.value.setModel(newModel);
      oldModel?.dispose();
    }
    editor.value.updateOptions({
      tabSize: getSettingForLanguage("editorTabSize", language),
      insertSpaces: getSettingForLanguage("editorInsertSpaces", language),
      padding: editorPadding(),
      ...largeFileEditorOptions(),
    });
  } else {
    const model = monaco.editor.createModel(editorContent, language, uri);
    clearModelMarkers(model);
    editor.value = monaco.editor.create(container, {
      ...editorOptions(),
      model,
      fixedOverflowWidgets: true,
    });
    editor.value.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => save());
    editor.value.addCommand(monaco.KeyCode.F1, () => {});
    // ⇧⌘L — Add to Agent.
    editor.value.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyL,
      () => { void ctxAddToAgent(); },
    );
    registerMarkdownKeybindings(editor.value);

    // Vue SFC: dynamically switch comment tokens based on cursor section
    const commentActions = ["editor.action.commentLine", "editor.action.blockComment"];
    for (const actionId of commentActions) {
      const orig = editor.value.getAction(actionId);
      if (!orig) continue;
      editor.value.addAction({
        id: `vue-${actionId}`,
        label: orig.label,
        keybindings:
          actionId === "editor.action.commentLine"
            ? [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Slash]
            : [monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyA],
        run: (ed) => {
          const model = ed.getModel();
          if (!model || model.getLanguageId() !== "vue") {
            orig.run();
            return;
          }
          const line = ed.getPosition()?.lineNumber ?? 1;
          const tokens = vueSectionComment(model, line);
          setVueComments({ lineComment: tokens.lineComment, blockComment: tokens.blockComment });
          orig.run();
        },
      });
    }

    // Monaco's ContextView service appends .context-view tooltips (find widget
    // button hovers, context menus) inside the editor container with position:absolute.
    // Ancestor overflow:hidden clips them. Convert to position:fixed on the fly.
    const editorDom = editor.value.getContainerDomNode();
    const contextViews = new Set<HTMLElement>();
    let patching = false;

    function patchContextView(el: HTMLElement) {
      if (el.style.display === "none" || el.style.position === "fixed") return;
      const absTop = parseFloat(el.style.top) || 0;
      const absLeft = parseFloat(el.style.left) || 0;
      const rect = editorDom.getBoundingClientRect();
      patching = true;
      el.style.position = "fixed";
      el.style.top = `${rect.top + absTop}px`;
      el.style.left = `${rect.left + absLeft}px`;
      patching = false;
    }

    hoverObserver = new MutationObserver((mutations) => {
      if (patching) return;
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node instanceof HTMLElement && node.classList.contains("context-view")) {
            contextViews.add(node);
            hoverObserver!.observe(node, { attributes: true, attributeFilter: ["style"] });
          }
        }
        if (
          m.type === "attributes" &&
          m.target instanceof HTMLElement &&
          contextViews.has(m.target)
        ) {
          patchContextView(m.target);
        }
      }
    });
    hoverObserver.observe(editorDom, { childList: true });
  }

  // Own + force layout: covers both the fresh-create and model-swap paths.
  attachLayoutObserver();
  await nextTick();
  scheduleLayout();
  ensureEditorLaidOut(1200);
  loading.value = false;
  mdContextKey?.set(isMarkdownPath(props.filePath));

  // Start LSP in background (no await — editor is immediately usable)
  if (props.rootDir && !profile.shouldDisableLanguageFeatures) {
    getOrStartClient(props.rootDir, language);
  }

  autoCloseTagDisposable = setupAutoCloseTags(editor.value);

  changeDisposable = editor.value.onDidChangeModelContent(() => {
    const content = editor.value!.getValue();
    const dirty = content !== baseContent;
    setDirty(dirty);
    emit("change", content);
    if (props.markdownPreview) previewContent.value = content;
    if (props.svgPreview) setSvgPreviewContent(content);
    scheduleAutoSave();
    // Persist dirty content (debounced 2s) — shadow for project files, in-memory for external.
    // Suspend persistence while the stale banner is open: a fresh shadow commit would re-read
    // current (externally-modified) disk and embed it as the new baseline, silently defeating
    // drift detection on the next load.
    if (shadowTimer) clearTimeout(shadowTimer);
    if (stale.value) return;
    const fp = currentFilePath;
    if (dirty && isExternalFile(fp)) {
      shadowTimer = setTimeout(() => {
        dirtyContentCacheSet(fp, content);
      }, 2000);
    } else if (dirty && props.rootDir) {
      shadowTimer = setTimeout(() => {
        persistProjectShadow(fp, content);
      }, 2000);
    }
  });

  // Mark dirty if shadow content differs from disk
  if (editorContent !== baseContent) {
    setDirty(true);
  }

  // Sync preview content for files that opened with preview already on
  // (watcher above only fires on toggle, not on initial mount).
  if (props.markdownPreview) previewContent.value = editorContent;
  if (props.svgPreview) setSvgPreviewContent(editorContent);

  // Track scroll/cursor for view state persistence. Guarded + in the common
  // path (not the create-only branch) so an editor first created via
  // initUntitled, then reused to load a real file, still wires these up.
  if (!scrollDisposable) {
    scrollDisposable = editor.value.onDidScrollChange(() => emitViewState());
    cursorDisposable = editor.value.onDidChangeCursorPosition(() => emitViewState());
  }
  // Selection tracking drives context-menu Cut/Copy enablement. Same reason as
  // above: must be wired in the reuse path, not only on fresh create.
  if (!selectionDisposable) {
    selectionDisposable = editor.value.onDidChangeCursorSelection((e) => {
      hasSelection.value = !e.selection.isEmpty();
    });
  }

  // Restore after model swap (deferred so Monaco finishes layout)
  restoreViewState();

  // Watch file for external changes via native fs watcher
  watchedPath = filePath;
  useRpc()
    .request.watchFile({ path: filePath })
    .catch(() => {});
  const unlisten = await listen<string>("file-changed", async (ev) => {
    if (ev.payload !== filePath) return;
    try {
      const r = await useRpc().request.getFileMtime({ path: filePath });
      if (r.mtime > currentMtime) {
        if (isDirty || hasShadow(filePath)) {
          stale.value = true;
        } else {
          await reload();
        }
      }
    } catch {}
  });
  if (!isCurrentLoad()) {
    unlisten();
    return;
  }
  fileWatchUnlisten = unlisten;
}

async function reload() {
  stale.value = false;
  await loadFile(props.filePath);
}

async function reloadFromDisk() {
  if (props.rootDir && !isExternalFile(currentFilePath)) {
    try {
      await useRpc().request.shadowRemove({
        dir: props.rootDir,
        relPath: relPathFor(currentFilePath),
      });
    } catch {}
  }
  forgetShadowContent(currentFilePath);
  dirtyContentCache.delete(currentFilePath);
  stale.value = false;
  await loadFile(currentFilePath);
}

async function keepMyChanges() {
  // Bump mtime so save()'s mtime check passes against the current disk state.
  try {
    const r = await useRpc().request.getFileMtime({ path: currentFilePath });
    currentMtime = r.mtime;
  } catch {}
  // Re-baseline the shadow against new disk content. shadowCommit reads disk
  // server-side and embeds the new baseline hash, so future drift checks work.
  if (editor.value && props.rootDir && !isExternalFile(currentFilePath)) {
    persistProjectShadow(currentFilePath, editor.value.getValue(), { retainHash: true });
  }
  stale.value = false;
}

// Emit view state on scroll/cursor changes (debounced)
let viewStateTimer: ReturnType<typeof setTimeout> | undefined;
function emitViewState() {
  clearTimeout(viewStateTimer);
  viewStateTimer = setTimeout(() => {
    if (!editor.value) return;
    const pos = editor.value.getPosition();
    emit("viewState", {
      scrollTop: editor.value.getScrollTop(),
      cursorLine: pos?.lineNumber ?? 1,
      cursorColumn: pos?.column ?? 1,
    });
  }, 300);
}

function restoreViewState() {
  if (!editor.value) return;
  if (props.initialScrollTop != null) {
    editor.value.setScrollTop(props.initialScrollTop);
  }
  if (props.initialCursorLine != null) {
    editor.value.setPosition({
      lineNumber: props.initialCursorLine,
      column: props.initialCursorColumn ?? 1,
    });
    if (props.initialScrollTop == null) {
      editor.value.revealLineInCenter(props.initialCursorLine);
    }
  }
  editor.value.focus();
}

function currentLspLanguage(): string | null {
  const modelLanguage = editor.value?.getModel()?.getLanguageId() ?? currentLanguage.value;
  return LSP_LANGUAGE_MAP[modelLanguage] ? modelLanguage : null;
}

function startCurrentLspClient(rootDir = props.rootDir) {
  if (!rootDir) return;
  if (!settings.value.lspEnabled) return;
  if (!currentFilePath || !currentFilePath.startsWith(rootDir + "/")) return;
  const modelLanguage = currentLspLanguage();
  if (!modelLanguage) return;
  getOrStartClient(rootDir, modelLanguage);
}

function stopCurrentLspClient(rootDir = props.rootDir) {
  if (!rootDir) return;
  const modelLanguage = currentLspLanguage();
  if (!modelLanguage) return;
  const language = LSP_LANGUAGE_MAP[modelLanguage];
  if (!language) return;
  stopClient(rootDir, language);
}

watch(
  () => props.filePath,
  (p) => {
    if (props.untitled) {
      initUntitled();
    } else {
      loadFile(p);
    }
  },
  { immediate: true },
);

watch(
  () => props.positionVersion,
  () => {
    const line = props.initialCursorLine;
    if (!editor.value || !line) return;
    editor.value.setPosition({ lineNumber: line, column: props.initialCursorColumn ?? 1 });
    editor.value.revealLineInCenter(line);
    editor.value.focus();
  },
);

watch(
  () => settings.value.lspEnabled,
  (enabled) => {
    if (enabled) startCurrentLspClient();
    else stopCurrentLspClient();
  },
);

watch(
  () => props.rootDir,
  async (rootDir) => {
    await nextTick();
    if (rootDir) startCurrentLspClient(rootDir);
  },
  { flush: "post" },
);

async function initUntitled() {
  await ensureEditorBootstrap(getActiveThemeSpec(), activeThemeName.value);
  loading.value = false;
  baseContent = "";
  currentContentProfile = null;
  largeFileMessage.value = null;
  // Clear the previous file path so context-menu Copy Path / relPath on an
  // untitled buffer don't report the stale prior file.
  currentFilePath = "";
  currentFilePathRef.value = "";
  mdContextKey?.set(isMarkdownPath(props.filePath));
  currentLanguage.value = "plaintext";
  await nextTick();
  if (!containerRef.value) return;
  if (editor.value) {
    const oldModel = editor.value.getModel();
    const newModel = monaco.editor.createModel("", "plaintext");
    editor.value.setModel(newModel);
    oldModel?.dispose();
    editor.value.setScrollPosition({ scrollTop: 0, scrollLeft: 0 });
  } else {
    const model = monaco.editor.createModel("", "plaintext");
    editor.value = monaco.editor.create(containerRef.value, {
      ...editorOptions(),
      model,
      fixedOverflowWidgets: true,
    });
    editor.value.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => save());
    editor.value.addCommand(monaco.KeyCode.F1, () => {});
    // ⇧⌘L — Add to Agent.
    editor.value.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyL,
      () => { void ctxAddToAgent(); },
    );
    registerMarkdownKeybindings(editor.value);
  }
  attachLayoutObserver();
  ensureEditorLaidOut(800);
  autoCloseTagDisposable?.dispose();
  autoCloseTagDisposable = setupAutoCloseTags(editor.value);
  changeDisposable?.dispose();
  changeDisposable = editor.value.onDidChangeModelContent(() => {
    const content = editor.value!.getValue();
    setDirty(content !== baseContent);
    emit("change", content);
    if (props.markdownPreview) previewContent.value = content;
    if (props.svgPreview) setSvgPreviewContent(content);
  });
  editor.value.focus();
}

watch(
  () => [
    settings.value.editorFontFamily,
    settings.value.editorFontWeight,
    settings.value.editorFontSize,
    settings.value.editorLineHeight,
    settings.value.editorWordWrap,
    settings.value.editorLineNumbers,
    settings.value.editorFontLigatures,
    settings.value.editorStickyScroll,
    settings.value.editorMinimap,
    settings.value.editorMinimapRenderCharacters,
    settings.value.editorMinimapScale,
    settings.value.editorMinimapShowSlider,
    settings.value.editorMinimapAutohide,
    settings.value.editorMultiCursorModifier,
    settings.value.editorTabSize,
    props.wordWrap,
    props.lineNumbers,
    props.minimap,
    settings.value.editorInsertSpaces,
  ],
  () => {
    if (!editor.value) return;
    const fontSize = settings.value.editorFontSize;
    const lh = settings.value.editorLineHeight;
    editor.value.updateOptions({
      fontFamily: settings.value.editorFontFamily,
      fontWeight: settings.value.editorFontWeight,
      fontSize,
      lineHeight: lh === 0 ? Math.round(fontSize * 1.5) : Math.max(lh, fontSize),
      tabSize: getSettingForLanguage("editorTabSize", currentLanguage.value),
      insertSpaces: getSettingForLanguage("editorInsertSpaces", currentLanguage.value),
      ...largeFileEditorOptions(),
      lineNumbers: resolvedLineNumbers() ? "on" : "off",
      fontLigatures: settings.value.editorFontLigatures,
      disableMonospaceOptimizations: settings.value.editorFontLigatures,
      multiCursorModifier: settings.value.editorMultiCursorModifier,
    });
  },
);

watch(activeThemeName, (name) => {
  editor.value?.updateOptions({ theme: name });
});

window.addEventListener("file-deleted-external", onExternalDelete);
window.addEventListener("clear-dirty-cache", onClearDirtyCache);

// Shadow flush on page unload (safety net)
function handleShadowFlush() {
  if (isDirty && editor.value) {
    const content = editor.value.getValue();
    if (isExternalFile(currentFilePath)) {
      dirtyContentCacheSet(currentFilePath, content);
    } else if (props.rootDir) {
      persistProjectShadow(currentFilePath, content, { retainHash: false });
    }
  } else if (currentFilePath && !isExternalFile(currentFilePath)) {
    forgetShadowContent(currentFilePath);
  }
}
window.addEventListener("shadow:flush", handleShadowFlush);

// Native menu Undo/Redo — routed here because native WKWebView undo
// only tracks the hidden textarea and drops edits Monaco intercepts (e.g. Enter).
function handleEditorAction(e: Event) {
  const action = (e as CustomEvent<string>).detail;
  if (!editor.value) return;
  // Palette/menu-triggered — run regardless of focus (the palette holds it).
  // save() no-ops unless this editor is dirty, so split panes only flush their own.
  if (action === "save") { void save(); return; }
  if (action === "addToAgent") { void ctxAddToAgent(); return; }
  // Focus-routed actions (⌘A/undo/redo dispatched globally by App.vue).
  if (!editor.value.hasTextFocus()) return;
  if (action === "undo") editor.value.trigger("menu", "undo", null);
  else if (action === "redo") editor.value.trigger("menu", "redo", null);
  else if (action === "selectAll") editor.value.trigger("menu", "editor.action.selectAll", null);
}
window.addEventListener("editor-action", handleEditorAction);

// ⌃G / `:` palette mode — jump to a line. With a number, reveal it directly;
// otherwise open Monaco's go-to-line widget.
function handleGotoLine(e: Event) {
  if (!editor.value) return;
  const line = (e as CustomEvent<number | undefined>).detail;
  editor.value.focus();
  if (typeof line === "number" && Number.isFinite(line)) {
    const max = editor.value.getModel()?.getLineCount() ?? line;
    const target = Math.min(Math.max(1, line), max);
    editor.value.setPosition({ lineNumber: target, column: 1 });
    editor.value.revealLineInCenter(target);
  } else {
    editor.value.trigger("palette", "editor.action.gotoLine", null);
  }
}
window.addEventListener("editor-goto-line", handleGotoLine);

// Monaco's automaticLayout (ResizeObserver) doesn't reliably catch the abrupt
// flex change when the file panel un-maximizes under WKWebView, leaving a blank
// viewport. Force an explicit remeasure on demand.
function handleRelayout() {
  ensureEditorLaidOut(500);
}
window.addEventListener("relayout-editors", handleRelayout);

onMounted(() => {
  resolveMounted();
});

onBeforeUnmount(() => {
  loadGeneration++;
  if (shadowTimer) clearTimeout(shadowTimer);
  if (isDirty && editor.value) {
    const content = editor.value.getValue();
    if (isExternalFile(currentFilePath)) {
      dirtyContentCacheSet(currentFilePath, content);
    } else if (props.rootDir) {
      persistProjectShadow(currentFilePath, content, { retainHash: false });
    }
  } else if (currentFilePath && !isExternalFile(currentFilePath)) {
    forgetShadowContent(currentFilePath);
  }
});

onUnmounted(() => {
  window.removeEventListener("file-deleted-external", onExternalDelete);
  window.removeEventListener("clear-dirty-cache", onClearDirtyCache);
  window.removeEventListener("shadow:flush", handleShadowFlush);
  window.removeEventListener("editor-action", handleEditorAction);
  window.removeEventListener("editor-goto-line", handleGotoLine);
  window.removeEventListener("relayout-editors", handleRelayout);
  if (shadowTimer) clearTimeout(shadowTimer);
  setSvgPreviewContent(null);
  // Clean up shadow for non-dirty project files (skip external files)
  if (!isDirty && props.rootDir && !isExternalFile(currentFilePath)) {
    useRpc()
      .request.shadowRemove({ dir: props.rootDir, relPath: relPath() })
      .catch(() => {});
    forgetShadowContent(currentFilePath);
  }
  if (fileWatchUnlisten) fileWatchUnlisten();
  if (watchedPath)
    useRpc()
      .request.unwatchFile({ path: watchedPath })
      .catch(() => {});
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  clearTimeout(viewStateTimer);
  if (layoutRaf) cancelAnimationFrame(layoutRaf);
  if (layoutRetryRaf) cancelAnimationFrame(layoutRetryRaf);
  resizeObserver?.disconnect();
  resizeObserver = null;
  hoverObserver?.disconnect();
  autoCloseTagDisposable?.dispose();
  changeDisposable?.dispose();
  scrollDisposable?.dispose();
  cursorDisposable?.dispose();
  selectionDisposable?.dispose();
  mdEnterDisposable?.dispose();
  editor.value?.getModel()?.dispose();
  editor.value?.dispose();
});
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden bg-[var(--editor-bg)]">
    <div
      v-if="stale"
      class="flex items-center gap-2 bg-amber-500/10 px-4 py-1.5 text-xs text-amber-400"
    >
      <span class="flex-1"
        >This file was modified outside the editor. Reload from disk, or keep your changes?</span
      >
      <button
        tabindex="0"
        class="rounded px-2 py-0.5 font-medium text-amber-300 hover:bg-amber-500/20"
        @click="reloadFromDisk"
      >
        Reload from disk
      </button>
      <button
        tabindex="0"
        class="rounded px-2 py-0.5 font-medium text-amber-300 hover:bg-amber-500/20"
        @click="keepMyChanges"
      >
        Keep my changes
      </button>
    </div>
    <div
      v-if="largeFileMessage"
      class="flex items-center gap-2 bg-sky-500/10 px-4 py-1.5 text-xs text-sky-300"
    >
      <AlertTriangle class="size-3.5 shrink-0" />
      <span class="flex-1">{{ largeFileMessage }}</span>
    </div>
    <MarkdownToolbar v-if="showMarkdownToolbar" @action="onFormatAction" />
    <div class="relative flex-1 overflow-hidden">
      <!-- Keep container always mounted so Monaco doesn't detach from DOM -->
      <ContextMenu>
        <ContextMenuTrigger class="block h-full w-full">
          <div ref="containerRef" class="h-full w-full" />
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem :disabled="!hasSelection" @select="ctxCut">
            Cut
            <ContextMenuShortcut>⌘X</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem :disabled="!hasSelection" @select="ctxCopy">
            Copy
            <ContextMenuShortcut>⌘C</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem @select="ctxPaste">
            Paste
            <ContextMenuShortcut>⌘V</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem @select="ctxAddToAgent">
            Add to Agent
            <ContextMenuShortcut>⇧⌘L</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem @select="ctxCopyPath">Copy Path</ContextMenuItem>
          <ContextMenuItem @select="ctxCopyRelativePath">Copy Relative Path</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem @select="ctxReveal">Reveal in Finder</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <div
        v-if="deleted"
        class="absolute inset-0 flex items-center justify-center bg-[var(--editor-bg)]"
      >
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <AlertTriangle class="size-5" />
            </EmptyMedia>
            <EmptyTitle>File deleted</EmptyTitle>
            <EmptyDescription>This file has been deleted or moved</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button size="sm" variant="outline" tabindex="0" @click="emit('close')"
              >Close Tab</Button
            >
          </EmptyContent>
        </Empty>
      </div>
      <div v-else-if="error" class="absolute inset-0 flex items-center justify-center text-red-400">
        {{ error }}
      </div>
      <!-- Cover Monaco while loading: its model still holds the previous file's
           text until the async read swaps it, so without this the new tab briefly
           shows the old file's content (e.g. a markdown source after leaving a
           preview). z below the preview/svg overlays so those win when active. -->
      <div v-if="loading" class="absolute inset-0 z-10 bg-[var(--editor-bg)]" />
      <div v-if="showPreview" class="absolute inset-0 z-20 bg-[color-mix(in_srgb,var(--sidebar)_65%,var(--editor-bg)_35%)]">
        <MarkdownPreview ref="previewRef" :key="props.filePath" :file-path="props.filePath" :content="previewContent" :initial-line="previewInitialLine" :initial-bottom="previewInitialBottom" />
      </div>
      <div v-if="showSvgPreview" class="absolute inset-0 z-20 flex items-center justify-center overflow-auto bg-[var(--editor-bg)] p-8">
        <img
          v-if="svgPreviewSrc"
          :src="svgPreviewSrc"
          alt=""
          class="max-w-full max-h-full object-contain"
        />
      </div>
    </div>

  </div>
</template>
