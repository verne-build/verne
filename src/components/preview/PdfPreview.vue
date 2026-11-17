<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import { GlobalWorkerOptions, getDocument, type PDFDocumentLoadingTask, type PDFDocumentProxy, type RenderTask } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { convertFileSrc, invoke } from "@/platform";
import { toast } from "vue-sonner";
import { Button } from "../ui/button";
import { AlertTriangle, ExternalLink, Loader2, Minus, Plus } from "@lucide/vue";

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

// pdf.js loads CMaps (CJK), standard fonts, ICC profiles and the JBIG2/JPEG2000
// wasm decoders at runtime. copyPdfJsAssets (electron.vite.config.ts) ships them
// next to index.html and serves them from /pdfjs/ in dev, so a document-relative
// URL works in both modes.
const PDFJS_ASSETS = new URL("pdfjs/", window.location.href).href;

// Keep a generous ceiling: pdf.js holds the whole document in memory, so a
// multi-hundred-MB PDF would be a renderer OOM rather than a slow render.
const MAX_PDF_BYTES = 150 * 1024 * 1024;
const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3] as const;

const props = defineProps<{ path: string }>();

interface PageSlot {
  num: number;
  /** height / width, so the placeholder reserves space before rendering. */
  ratio: number;
}

const scroller = ref<HTMLDivElement | null>(null);
const status = ref<"loading" | "ready" | "error">("loading");
const errorMessage = ref("");
const pageCount = ref(0);
const pages = ref<PageSlot[]>([]);
const zoom = ref(1);
const doc = shallowRef<PDFDocumentProxy | null>(null);

const pageEls = new Map<number, HTMLElement>();
const canvasEls = new Map<number, HTMLCanvasElement>();
const renderTasks = new Map<number, RenderTask>();
const renderedAt = new Map<number, number>();
const visible = new Set<number>();

let observer: IntersectionObserver | null = null;
let resizeObserver: ResizeObserver | null = null;
let resizeTimer: ReturnType<typeof setTimeout> | null = null;
let generation = 0;
let destroyed = false;
// v6 moved teardown onto the loading task — the document proxy no longer owns
// `destroy()`, so keep the task around for cancellation.
let loadingTask: PDFDocumentLoadingTask | null = null;

const zoomPercent = computed(() => Math.round(zoom.value * 100));

function friendlyError(e: unknown): string {
  const name = (e as { name?: string })?.name;
  if (name === "PasswordException") return "This PDF is password-protected.";
  if (name === "InvalidPDFException") return "This file isn't a valid PDF.";
  if (name === "MissingPDFException") return "The PDF file was not found (it may have been deleted or moved).";
  return (e as Error)?.message ?? String(e);
}

function setPageEl(num: number, el: unknown): void {
  if (el instanceof HTMLElement) {
    pageEls.set(num, el);
    observer?.observe(el);
  } else {
    pageEls.delete(num);
  }
}

function setCanvasEl(num: number, el: unknown): void {
  if (el instanceof HTMLCanvasElement) canvasEls.set(num, el);
  else canvasEls.delete(num);
}

async function renderPage(num: number): Promise<void> {
  const d = doc.value;
  const host = pageEls.get(num);
  const canvas = canvasEls.get(num);
  if (!d || !host || !canvas) return;
  if (renderedAt.get(num) === zoom.value) return;
  const gen = generation;

  renderTasks.get(num)?.cancel();
  try {
    const page = await d.getPage(num);
    if (gen !== generation) return;
    const base = page.getViewport({ scale: 1 });
    const slot = pages.value.find((p) => p.num === num);
    if (slot) slot.ratio = base.height / base.width;

    // Fit the page to the slot's CSS width, then scale up for HiDPI so the
    // canvas isn't blurry on Retina.
    const cssWidth = Math.max(1, host.clientWidth);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const viewport = page.getViewport({ scale: (cssWidth / base.width) * dpr });
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));

    const task = page.render({ canvas, viewport });
    renderTasks.set(num, task);
    await task.promise;
    if (gen !== generation) return;
    renderedAt.set(num, zoom.value);
  } catch (e) {
    if ((e as { name?: string })?.name === "RenderingCancelledException") return;
    console.warn("[pdf] page render failed", num, e);
  } finally {
    renderTasks.delete(num);
  }
}

function renderVisible(): void {
  for (const num of visible) void renderPage(num);
}

function reRenderAll(): void {
  renderedAt.clear();
  renderVisible();
}

function onIntersect(entries: IntersectionObserverEntry[]): void {
  for (const entry of entries) {
    const num = Number((entry.target as HTMLElement).dataset.page);
    if (!num) continue;
    if (entry.isIntersecting) {
      visible.add(num);
      void renderPage(num);
    } else {
      visible.delete(num);
    }
  }
}

function teardownPages(): void {
  observer?.disconnect();
  observer = null;
  for (const task of renderTasks.values()) task.cancel();
  renderTasks.clear();
  renderedAt.clear();
  visible.clear();
  pageEls.clear();
  canvasEls.clear();
  pages.value = [];
}

async function closeDoc(): Promise<void> {
  doc.value = null;
  const task = loadingTask;
  loadingTask = null;
  if (!task) return;
  try {
    await task.destroy();
  } catch {
    // already destroyed / worker gone — nothing to clean up
  }
}

async function load(): Promise<void> {
  const gen = ++generation;
  status.value = "loading";
  errorMessage.value = "";
  pageCount.value = 0;
  teardownPages();
  await closeDoc();

  try {
    const res = await fetch(convertFileSrc(props.path));
    if (!res.ok) throw new Error(`Could not read file (HTTP ${res.status})`);
    const size = Number(res.headers.get("content-length") ?? 0);
    if (size > MAX_PDF_BYTES) {
      throw new Error(`PDF is too large to preview (${Math.round(size / 1024 / 1024)} MB). Open it in your default app.`);
    }
    const data = new Uint8Array(await res.arrayBuffer());
    if (gen !== generation) return;

    const task = getDocument({
      data,
      wasmUrl: `${PDFJS_ASSETS}wasm/`,
      cMapUrl: `${PDFJS_ASSETS}cmaps/`,
      standardFontDataUrl: `${PDFJS_ASSETS}standard_fonts/`,
      iccUrl: `${PDFJS_ASSETS}iccs/`,
    });
    loadingTask = task;
    const loaded = await task.promise;
    if (gen !== generation) {
      await task.destroy();
      return;
    }
    doc.value = loaded;
    pageCount.value = loaded.numPages;

    const first = await loaded.getPage(1);
    const firstViewport = first.getViewport({ scale: 1 });
    pages.value = Array.from({ length: loaded.numPages }, (_, i) => ({
      num: i + 1,
      ratio: firstViewport.height / firstViewport.width,
    }));

    status.value = "ready";
    await nextTick();
    if (gen !== generation || destroyed) return;

    observer = new IntersectionObserver(onIntersect, {
      root: scroller.value,
      rootMargin: "1200px 0px",
    });
    for (const el of pageEls.values()) observer.observe(el);
  } catch (e) {
    if (gen !== generation) return;
    if (loadingTask) {
      void loadingTask.destroy().catch(() => {});
      loadingTask = null;
    }
    status.value = "error";
    errorMessage.value = friendlyError(e);
  }
}

function setZoom(next: number): void {
  const clamped = Math.min(ZOOM_STEPS[ZOOM_STEPS.length - 1], Math.max(ZOOM_STEPS[0], next));
  if (clamped === zoom.value) return;
  zoom.value = clamped;
  void nextTick(() => reRenderAll());
}

function zoomIn(): void {
  const next = ZOOM_STEPS.find((s) => s > zoom.value);
  if (next !== undefined) setZoom(next);
}

function zoomOut(): void {
  const prev = [...ZOOM_STEPS].reverse().find((s) => s < zoom.value);
  if (prev !== undefined) setZoom(prev);
}

function openExternally(): void {
  void invoke("open_path", { path: props.path }).catch((e) => toast.error(String(e)));
}

onMounted(() => {
  void load();
  resizeObserver = new ResizeObserver(() => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      reRenderAll();
    }, 150);
  });
  if (scroller.value) resizeObserver.observe(scroller.value);
});

onBeforeUnmount(() => {
  destroyed = true;
  generation++;
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeObserver?.disconnect();
  resizeObserver = null;
  teardownPages();
  void closeDoc();
});
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-muted/20">
    <div class="flex h-8 shrink-0 items-center gap-1 border-b border-border bg-sidebar px-2 text-xs text-muted-foreground">
      <template v-if="status === 'ready'">
        <Button size="icon-xs" variant="ghost" aria-label="Zoom out" :disabled="zoom <= ZOOM_STEPS[0]" @click="zoomOut">
          <Minus class="size-3.5" />
        </Button>
        <button class="min-w-10 rounded px-1 tabular-nums hover:text-foreground" title="Reset to fit width" @click="setZoom(1)">
          {{ zoomPercent }}%
        </button>
        <Button size="icon-xs" variant="ghost" aria-label="Zoom in" :disabled="zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1]" @click="zoomIn">
          <Plus class="size-3.5" />
        </Button>
        <span class="ml-2">{{ pageCount }} {{ pageCount === 1 ? "page" : "pages" }}</span>
      </template>
      <span class="flex-1" />
      <Button size="sm" variant="ghost" class="text-xs" @click="openExternally">
        <ExternalLink class="size-3.5" /> Open Externally
      </Button>
    </div>

    <div ref="scroller" class="min-h-0 flex-1 overflow-auto p-4">
      <div v-if="status === 'loading'" class="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 class="size-5 animate-spin" />
      </div>

      <div v-else-if="status === 'error'" class="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <AlertTriangle class="size-6 text-muted-foreground" />
        <div class="text-sm text-foreground">Couldn't open this PDF</div>
        <div class="max-w-sm text-xs text-muted-foreground">{{ errorMessage }}</div>
        <Button size="sm" variant="outline" @click="openExternally">
          <ExternalLink class="size-3.5" /> Open in Default App
        </Button>
      </div>

      <div v-else class="mx-auto flex flex-col items-center gap-3" :style="{ width: `${zoom * 100}%` }">
        <div
          v-for="p in pages"
          :key="p.num"
          :ref="(el) => setPageEl(p.num, el)"
          :data-page="p.num"
          class="pdf-page relative w-full overflow-hidden rounded-sm bg-white shadow-sm ring-1 ring-black/10"
          :style="{ aspectRatio: `1 / ${p.ratio}` }"
        >
          <canvas :ref="(el) => setCanvasEl(p.num, el)" class="absolute inset-0 h-full w-full" />
        </div>
      </div>
    </div>
  </div>
</template>
