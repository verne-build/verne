<script setup lang="ts">
import { shallowRef, watch, onUnmounted, onMounted, useTemplateRef, createApp, type App } from "vue";
import { pinia } from "@/stores/pinia";
import { FileDiff, parseDiffFromFile } from "@pierre/diffs";
import type { FileContents, DiffLineAnnotation, SelectedLineRange } from "@pierre/diffs";
import { useDiffHighlighter } from "@/composables/useDiffHighlighter";
import { useTheme } from "@/composables/useTheme";
import { useDiffReview } from "@/composables/useDiffReview";
import { useSettings } from "@/composables/useSettings";
import DiffCommentBox from "./DiffCommentBox.vue";
import type { ReviewContext } from "@/types/shared";

const props = withDefaults(
  defineProps<{
    filePath: string;
    original: string;
    modified: string;
    rootDir?: string;
    layout?: "unified" | "split";
    reviewContext?: ReviewContext;
  }>(),
  { layout: "unified" },
);

const emit = defineEmits<{
  stats: [stats: { added: number; deleted: number } | null];
  ready: [];
  error: [message: string];
}>();

const { activeThemeName } = useTheme();
const { settings } = useSettings();
const ready = shallowRef(false);
const error = shallowRef<string | null>(null);

const containerRef = useTemplateRef<HTMLDivElement>("containerRef");
const fileDiff = shallowRef<FileDiff<{ commentId: string }> | null>(null);
// live host so font/size/line-height watchers can repaint without a rebuild
const pierreHost = shallowRef<HTMLElement | null>(null);

// editorLineHeight 0 = auto; mirror CodeEditor so diff matches the editor
function diffLineHeight(): number {
  const fs = settings.value.editorFontSize;
  const lh = settings.value.editorLineHeight;
  return lh === 0 ? Math.round(fs * 1.5) : Math.max(lh, fs);
}

function applyEditorFont(el: HTMLElement) {
  el.style.setProperty("--diffs-font-family", settings.value.editorFontFamily);
  el.style.setProperty("--diffs-font-size", `${settings.value.editorFontSize}px`);
  el.style.setProperty("--diffs-line-height", `${diffLineHeight()}px`);
}

let loadGen = 0;
let selectionObserver: MutationObserver | null = null;

const review = useDiffReview();
// commentId -> mounted box app + its host node
const mounted = new Map<string, { app: App; host: HTMLElement }>();

const reviewSelectionCSS = `
  [data-selected-line] {
    --diffs-line-bg: color-mix(
      in srgb,
      rgb(59 130 246) 38%,
      var(--diffs-computed-diff-line-bg)
    ) !important;
  }

  [data-column-number][data-selected-line] {
    background-image: linear-gradient(white, white);
    background-position: right center;
    background-repeat: no-repeat;
    background-size: 2px 100%;
  }

  [data-column-number][data-selected-line="first"] {
    overflow: visible;
  }

  [data-utility-button][data-selection-start-handle] {
    position: absolute;
    top: 0;
    right: -0.5lh;
    width: 1lh;
    height: 1lh;
    margin: 0;
    padding: 0;
    border: 0;
    border-radius: 5px;
    background: white;
    color: rgb(45 55 70);
    fill: currentColor;
    box-shadow: none;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 5;
    pointer-events: none;
  }

  [data-gutter-utility-slot] {
    overflow: visible;
  }

  [data-utility-button] {
    width: 1lh;
    height: 1lh;
    margin-right: -0.5lh;
    border: 0;
    border-radius: 5px;
    background: white;
    color: rgb(45 55 70);
    box-shadow: none;
  }

  [data-gutter] [data-gutter-buffer],
  [data-gutter] [data-column-number] {
    border-right: 0;
  }

  [data-line-annotation],
  [data-gutter-buffer="annotation"] {
    --diffs-annotation-bg: var(--editor-bg);
    --diffs-computed-decoration-bg: var(--editor-bg);
    --diffs-computed-diff-line-bg: var(--editor-bg);
    --diffs-computed-selected-line-bg: var(--editor-bg);
    --diffs-line-bg: var(--editor-bg);
    background-color: var(--editor-bg);
  }

  [data-line-annotation] [data-annotation-content] {
    padding: 8px 12px 8px 0;
  }

  [data-interactive-line-numbers] [data-column-number] {
    cursor: default;
  }

  [data-utility-button] {
    cursor: pointer;
  }

  [data-indicators="bars"]
    [data-line-type="change-addition"][data-column-number]::before,
  [data-indicators="bars"]
    [data-line-type="change-deletion"][data-column-number]::before {
    display: none;
  }

  [data-indicators="bars"]
    [data-line-type="change-addition"][data-column-number] {
    box-shadow: inset 2px 0 var(--diffs-addition-base);
  }

  [data-indicators="bars"]
    [data-line-type="change-deletion"][data-column-number] {
    box-shadow: inset 2px 0 var(--diffs-deletion-base);
  }

  [data-indicators="bars"]
    [data-line-type="change-addition"][data-column-number][data-selected-line] {
    box-shadow: inset 2px 0 color-mix(
      in srgb,
      rgb(59 130 246) 38%,
      var(--diffs-addition-base)
    );
  }

  [data-indicators="bars"]
    [data-line-type="change-deletion"][data-column-number][data-selected-line] {
    box-shadow: inset 2px 0 color-mix(
      in srgb,
      rgb(59 130 246) 38%,
      var(--diffs-deletion-base)
    );
  }
`;

function allowOnlyHandleSelection(event: PointerEvent) {
  const path = event.composedPath();
  const isHandle = path.some(
    (target) => target instanceof HTMLElement && target.hasAttribute("data-utility-button"),
  );
  if (isHandle) return;

  const isNumberColumn = path.some(
    (target) => target instanceof HTMLElement && target.hasAttribute("data-column-number"),
  );
  if (isNumberColumn) event.stopPropagation();
}

function syncSelectionStartHandle(pierreEl: HTMLElement) {
  const root = pierreEl.shadowRoot;
  if (!root) return;

  root.querySelector("[data-selection-start-handle]")?.remove();
  const first = root.querySelector<HTMLElement>(
    '[data-column-number][data-selected-line="first"]',
  );
  const utility = root.querySelector<HTMLButtonElement>(
    "[data-utility-button]:not([data-selection-start-handle])",
  );
  if (!first || !utility) return;

  const startHandle = utility.cloneNode(true) as HTMLButtonElement;
  startHandle.setAttribute("data-selection-start-handle", "");
  startHandle.tabIndex = -1;
  first.appendChild(startHandle);
}

function observeSelection(pierreEl: HTMLElement) {
  selectionObserver?.disconnect();
  const root = pierreEl.shadowRoot;
  if (!root) return;

  selectionObserver = new MutationObserver(() => syncSelectionStartHandle(pierreEl));
  selectionObserver.observe(root, {
    subtree: true,
    attributes: true,
    attributeFilter: ["data-selected-line"],
  });
  syncSelectionStartHandle(pierreEl);
}

function unmountAllAnnotations() {
  for (const { app } of mounted.values()) app.unmount();
  mounted.clear();
}

function clearReviewSelection() {
  fileDiff.value?.setSelectedLines(null);
}

function discardEmptyDrafts() {
  const ctx = props.reviewContext;
  if (!ctx) return;
  for (const comment of review.commentsForFile(ctx.scopeKey, ctx)) {
    if (!comment.body.trim()) void review.removeComment(comment.id);
  }
}

function snippetForRange(side: "additions" | "deletions", start: number, end: number): string {
  const src = side === "deletions" ? props.original : props.modified;
  const lines = src.split("\n");
  return lines.slice(start - 1, end).join("\n");
}

function renderAnnotation(a: DiffLineAnnotation<{ commentId: string }>): HTMLElement {
  const id = a.metadata.commentId;
  const existing = mounted.get(id);
  if (existing) return existing.host;
  const host = document.createElement("div");
  const app = createApp(DiffCommentBox, {
    commentId: id,
    onClearSelection: clearReviewSelection,
  });
  // Reuse the shared Pinia so the comment box's send-to-agent menu can read the
  // workspace store (this island has its own app instance).
  app.use(pinia);
  app.mount(host);
  mounted.set(id, { app, host });
  return host;
}

function onGutterClick(range: SelectedLineRange) {
  const ctx = props.reviewContext;
  if (!ctx) return;
  const side = (range.side ?? "additions") as "additions" | "deletions";
  const start = Math.min(range.start, range.end);
  const end = Math.max(range.start, range.end);
  void review.addComment({
    scopeKey: ctx.scopeKey, source: ctx.source, relPath: ctx.relPath,
    staged: ctx.staged, commitSha: ctx.commitSha,
    side, startLine: start, endLine: end,
    snippet: snippetForRange(side, start, end), body: "",
  });
}

function applyAnnotations() {
  if (!fileDiff.value || !props.reviewContext) return;
  const desired = review.commentsForFile(props.reviewContext.scopeKey, props.reviewContext);
  if (desired.length === 0) clearReviewSelection();
  const desiredIds = new Set(desired.map((c) => c.id));
  // Unmount boxes for comments no longer present.
  let removed = false;
  for (const [id, m] of mounted) {
    if (!desiredIds.has(id)) { m.app.unmount(); mounted.delete(id); removed = true; }
  }
  // Nothing to render and nothing was just removed → skip the full rerender.
  // Keeps the common comment-free diff from paying for a second render pass.
  if (desired.length === 0 && !removed) return;
  fileDiff.value.setLineAnnotations(review.annotationsForFile(props.reviewContext.scopeKey, props.reviewContext));
  fileDiff.value.rerender();
}

// cyrb53 — fast 53-bit string hash. Used as the FileContents.cacheKey input
// so Pierre's WorkerPoolManager.diffCache (LRU) actually populates and we
// skip re-tokenization when the same diff re-opens (tab switch, navigation).
function hashStr(s: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

function makeFileContents(content: string, side: "old" | "new"): FileContents {
  return {
    name: props.filePath,
    contents: content,
    cacheKey: `${side}:${props.filePath}:${content.length}:${hashStr(content)}`,
  };
}

function computeStats(): { added: number; deleted: number } {
  const meta = parseDiffFromFile(
    makeFileContents(props.original, "old"),
    makeFileContents(props.modified, "new"),
  );
  let added = 0;
  let deleted = 0;
  for (const h of meta.hunks ?? []) {
    added += h.additionLines ?? 0;
    deleted += h.deletionLines ?? 0;
  }
  return { added, deleted };
}

async function build() {
  const gen = ++loadGen;
  selectionObserver?.disconnect();
  selectionObserver = null;
  unmountAllAnnotations();
  ready.value = false;
  error.value = null;

  try {
    const { workerManager } = await useDiffHighlighter();
    if (gen !== loadGen) return;

    fileDiff.value?.cleanUp();

    fileDiff.value = new FileDiff<{ commentId: string }>(
      {
        theme: activeThemeName.value,
        diffStyle: props.layout,
        disableFileHeader: true,
        diffIndicators: "bars",
        unsafeCSS: reviewSelectionCSS,
        enableGutterUtility: !!props.reviewContext,
        // Keep Pierre's range preview enabled, but the host capture listener
        // below prevents ordinary gutter presses from starting it.
        enableLineSelection: !!props.reviewContext,
        onGutterUtilityClick: onGutterClick,
        renderAnnotation,
      },
      workerManager,
    );

    // Pierre's CSS lives in shadow DOM on <diffs-container>. Pierre reads
    // theme.bg/fg/git-decoration colors from the loaded Shiki theme and
    // auto-tints diff backgrounds — so we only override the chrome bits
    // (buffer pills, separators, line numbers) for visual consistency
    // with Verne. color-scheme:dark beats pierre's `:host { color-scheme:
    // light dark }` so its `light-dark()` fallbacks pick dark variants.
    const pierreEl = document.createElement("diffs-container");
    pierreEl.style.cssText = `
      color-scheme: dark;
      --diffs-bg-buffer-override: var(--muted);
      --diffs-bg-separator-override: var(--border);
      --diffs-fg-number-override: var(--muted-foreground);
      --diffs-selection-color-override: rgb(96 165 250);
    `;
    applyEditorFont(pierreEl);
    pierreHost.value = pierreEl;
    if (props.reviewContext) {
      pierreEl.addEventListener("pointerdown", allowOnlyHandleSelection, { capture: true });
    }
    containerRef.value!.replaceChildren(pierreEl);

    fileDiff.value.render({
      oldFile: makeFileContents(props.original, "old"),
      newFile: makeFileContents(props.modified, "new"),
      fileContainer: pierreEl,
    });
    observeSelection(pierreEl);

    const s = computeStats();
    emit("stats", s);
    ready.value = true;
    emit("ready");
    applyAnnotations();
  } catch (e) {
    console.error("[DiffView] render failed", e);
    error.value = "Failed to render diff";
    ready.value = true;
    emit("error", "Failed to render diff");
  }
}

onMounted(build);
watch(() => [props.filePath, props.original, props.modified] as const, build);
watch(activeThemeName, async () => {
  if (!fileDiff.value) return;
  fileDiff.value.setOptions({
    theme: activeThemeName.value,
    diffStyle: props.layout,
    disableFileHeader: true,
    diffIndicators: "bars",
  });
  const { workerManager } = await useDiffHighlighter();
  if (workerManager) {
    await workerManager.setRenderOptions({ theme: activeThemeName.value });
  }
  // rerender unconditionally: with a worker manager, setRenderOptions alone
  // doesn't repaint the already-rendered diff, so it kept the old theme.
  fileDiff.value?.rerender();
});
watch(() => props.layout, (v) => {
  if (!fileDiff.value) return;
  fileDiff.value.setOptions({
    theme: activeThemeName.value,
    diffStyle: v,
    disableFileHeader: true,
    diffIndicators: "bars",
  });
  fileDiff.value.rerender();
});
watch(
  () => (props.reviewContext ? review.commentsForFile(props.reviewContext.scopeKey, props.reviewContext) : []),
  () => applyAnnotations(),
  { deep: true },
);
// font/size/line-height are pure CSS vars — repaint the host, no rerender
watch(
  () => [settings.value.editorFontFamily, settings.value.editorFontSize, settings.value.editorLineHeight] as const,
  () => {
    if (pierreHost.value) applyEditorFont(pierreHost.value);
  },
);

onUnmounted(() => {
  loadGen++;
  discardEmptyDrafts();
  selectionObserver?.disconnect();
  selectionObserver = null;
  fileDiff.value?.cleanUp();
  unmountAllAnnotations();
  pierreHost.value = null;
});
</script>

<template>
  <div class="relative h-full w-full">
    <div
      ref="containerRef"
      class="h-full w-full overflow-auto"
      :style="{ opacity: ready && !error ? 1 : 0 }"
    />
    <div
      v-if="error"
      class="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground"
    >
      {{ error }}
    </div>
  </div>
</template>
