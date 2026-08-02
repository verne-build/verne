<script setup lang="ts">
// Canvas grid-streaming terminal (the xterm replacement). Mounts a <canvas>,
// wires GridStore + GridSession + Canvas2DRenderer through TerminalController,
// and a hidden textarea for keyboard/IME. Non-destructive: this is a new
// component used behind a dev toggle; the xterm path is untouched until cutover.

import { computed, onMounted, onBeforeUnmount, ref, watch, nextTick } from 'vue';
import { invoke } from '../../platform';
import { useRpc } from '../../composables/useRpc';
import { useSettings } from '../../composables/useSettings';
import { useTheme } from '../../composables/useTheme';
import { GridStore } from '../../lib/terminal/GridStore';
import { GridSession } from '../../lib/terminal/GridSession';
import {
  acquireLiveGridRuntime,
  acquireRetainedLiveGridRuntime,
  hasRetainedGridFrame,
  type LiveGridRuntimeLease,
} from '../../lib/terminal/liveGridRuntime';
import { TerminalController } from '../../lib/terminal/TerminalController';
import { StaticGridTransport } from '../../lib/terminal/StaticGridTransport';
import {
  decodeArchivedSnapshot,
  gridStoreFromArchivedSnapshot,
  isCurrentArchivedRead,
  isPartialArchivedSnapshot,
} from '../../lib/terminal/archivedSnapshot';
import { createRenderer, makeCanvas2D, type RendererOptions } from '../../lib/terminal/createRenderer';
import { cellWidthFor, cellHeightFor, gridSizeFor } from '../../lib/terminal/metrics';
import { defaultPalette, resolveColor, type Palette } from '../../lib/terminal/palette';
import { positionToScrollOffset, sliderGeometry, lineToTrackY } from '../../lib/terminal/scrollbar';
import TerminalFindBox from './TerminalFindBox.vue';
import { gridToText, rowToText } from '../../lib/terminal/a11y';
import { registerGridSession, unregisterGridSession } from '../../composables/useTerminal';
import { beginGridResize, endGridResize } from '../../lib/panelAnimationState';
import type { FontMetrics, TerminalRenderer } from '../../lib/terminal/renderer';

// `cwd` resolves repo-relative file links (e.g. electron/main/window.ts).
// `autoFocus` (default true): grab keyboard focus on mount. Multi-pane mounts
// gate this to the focused pane so last-mount-wins can't steal focus.
// Exactly one of `sessionId` (live PTY) / `archivedTabId` (frozen snapshot) is
// set; archived mode opens no socket and accepts no input.
const props = defineProps<{
  sessionId?: string;
  archivedTabId?: string;
  cwd?: string;
  autoFocus?: boolean;
}>();

/** Archived (read-only snapshot) vs live. Fixed at mount. */
const archived = computed(() => props.archivedTabId != null);
/** Set true when the stored snapshot can't be read/decoded; the host still shows
 *  the un-archive controls. */
const snapshotUnavailable = ref(false);
/** Guards the async archived read against a teardown mid-flight. */
let disposed = false;
// Emitted after each applySize with the pane's grid size, so the workspace can
// keep backgrounded single-pane tabs sized to the viewport (no reactivation jump).
// `archivedPartial` fires once per archived mount: true when the capture only
// holds the final screen (alt-screen TUI), so the host can label it.
const emit = defineEmits<{
  resized: [cols: number, rows: number];
  archivedPartial: [partial: boolean];
}>();

const container = ref<HTMLDivElement | null>(null);
const canvas = ref<HTMLCanvasElement | null>(null);
const hiddenInput = ref<HTMLTextAreaElement | null>(null);

// Scrollbar + jump-to-latest UI state (refreshed after each paint).
const sliderVisible = ref(false);
const sliderTop = ref(0);
const sliderHeight = ref(0);
const sliderDragging = ref(false);
const showJump = ref(false);

// Find/search overlay state.
const findOpen = ref(false);
const findQuery = ref('');
const findCaseSensitive = ref(false);
const findCurrent = ref(-1);
const findTotal = ref(0);
const findBox = ref<InstanceType<typeof TerminalFindBox> | null>(null);
const searchTicks = ref<{ top: number; active: boolean }[]>([]);
let searchDebounce: ReturnType<typeof setTimeout> | null = null;

// Link hover underline overlay (shown while a modifier is held over a link).
const linkUnderline = ref<{ left: number; top: number; width: number; height: number; color: string } | null>(null);
/** Last canvas-relative pointer position, so a modifier press re-evaluates the
 *  link affordance without needing the mouse to move. */
let lastHover: { x: number; y: number } | null = null;

// IME: the hidden textarea is moved to the cursor cell so the OS candidate
// window anchors there, and made visible during composition to show preedit.
const composing = ref(false);
const caretLeft = ref(0);
const caretTop = ref(0);
const caretWidth = ref(0);

// Screen-reader surfaces.
const a11yMirror = ref<HTMLDivElement | null>(null);
const ariaLive = ref('');
let lastAnnounced = '';

const { settings } = useSettings();
const { getActiveThemeSpec, themeVersion } = useTheme();

/** Inner padding around the cell grid (user setting; breathing room/gutter feel). */
const pad = computed(() => settings.value.terminalPadding ?? 10);

/** Container background; matches the editor background so any gap around the
 *  cell grid blends in. */
const bgColor = ref(defaultPalette.background);

/** Memoized paletteFromTheme() — rebuilt only on theme change (the watch below). */
let cachedPalette: Palette | null = null;
function themePalette(): Palette {
  return (cachedPalette ??= paletteFromTheme());
}

let controller: TerminalController | null = null;
let session: GridSession | null = null;
let runtimeLease: LiveGridRuntimeLease | null = null;
let renderer: TerminalRenderer | null = null;
/** 'webgl2' until a context loss demotes us to 'canvas2d'. */
let renderKind: 'webgl2' | 'canvas2d' = 'canvas2d';
let resizeObserver: ResizeObserver | null = null;
let raf = 0;
let cnv: HTMLCanvasElement | null = null;
/** Set only on the Canvas2D path (for device-pixel transform on resize). */
let ctx2d: CanvasRenderingContext2D | null = null;
let metrics: FontMetrics;
/** dpr the current `metrics` were device-aligned against; re-measure when the
 *  window moves to a monitor with a different ratio (else cells de-align). */
let metricsDpr = 0;
/** Last grid size handed to `controller.resize` — a repeat is a daemon no-op. */
let lastAppliedCols = 0;
let lastAppliedRows = 0;

/** Current renderer construction options, derived from settings + theme. */
function rendererOptions(): RendererOptions {
  return {
    metrics,
    palette: paletteFromTheme(),
    ligatures: settings.value.terminalFontLigatures,
    boldIsBright: settings.value.terminalBoldIsBright,
    minContrast: settings.value.terminalMinimumContrast,
    preferWebgl: settings.value.terminalRenderer === 'webgl',
  };
}

/** Build the terminal palette from the active theme: ANSI/fg/cursor from the
 *  theme's terminal block, background from the editor background so the terminal
 *  matches the editor. */
function paletteFromTheme(): Palette {
  const t = getActiveThemeSpec();
  const term = t.terminal;
  const a = term.ansi;
  const b = term.ansiBright;
  return {
    background: t.editor['editor.background'] ?? term.background,
    foreground: term.foreground,
    cursor: term.cursor,
    selection: term.selectionBackground ?? defaultPalette.selection,
    searchMatch: t.editor['editor.findMatchHighlightBackground'] ?? defaultPalette.searchMatch,
    searchMatchCurrent: t.editor['editor.findMatchBackground'] ?? defaultPalette.searchMatchCurrent,
    ansi: [
      a.black, a.red, a.green, a.yellow, a.blue, a.magenta, a.cyan, a.white,
      b.black, b.red, b.green, b.yellow, b.blue, b.magenta, b.cyan, b.white,
    ],
  };
}

/** Derive cell metrics from the user's terminal font settings. cellWidth/Height
 *  are device-aligned (see metrics.ts): the renderers snap cell positions to the
 *  device-pixel grid, so a fractional cellWidth would make adjacent columns round
 *  to different widths and stretch the same glyph differently per column ("letters
 *  change size"). Aligning to whole device pixels makes every cell identical. */
function measure(): FontMetrics {
  const s = settings.value;
  const family = s.terminalFontFamily || 'monospace';
  const size = s.terminalFontSize || 13;
  const lineHeight = s.terminalLineHeight || 1.2;
  const dpr = window.devicePixelRatio || 1;
  const probe = document.createElement('canvas').getContext('2d')!;
  probe.font = `${size}px ${family}`;
  const cellWidth = cellWidthFor(probe.measureText('M').width, dpr);
  const cellHeight = cellHeightFor(size, lineHeight, dpr);
  // Vertically center the glyph within the (possibly taller) line box.
  const baseline = Math.round((cellHeight - size) / 2 + size * 0.8);
  return { cellWidth, cellHeight, baseline, fontFamily: family, fontSize: size };
}

function gridSize(): { cols: number; rows: number } | null {
  const el = container.value;
  if (!el) return null;
  return gridSizeFor(el.clientWidth, el.clientHeight, pad.value, metrics);
}

/** Signature of the last searchTicks rebuild (count:active:extent). */
let lastTicksKey = '';

/** Refresh the scrollbar slider + jump-to-latest pill from store scroll state. */
function updateScrollUi(): void {
  if (!controller) return;
  const s = controller.store;
  const trackPx = s.rows * metrics.cellHeight;
  const g = sliderGeometry(s.rows, s.totalLines, trackPx, s.scrollPos);
  sliderVisible.value = g.visible;
  sliderTop.value = pad.value + g.pos;
  sliderHeight.value = g.size;
  showJump.value = !s.atBottom() && s.hasNewOutputWhileScrolled;

  // Anchor the IME caret at the cursor cell (valid while following the tail).
  caretLeft.value = pad.value + s.cursor[1] * metrics.cellWidth;
  caretTop.value = pad.value + s.cursor[0] * metrics.cellHeight;
  caretWidth.value = Math.max(metrics.cellWidth * 4, (s.cols - s.cursor[1]) * metrics.cellWidth);

  updateA11y(s);

  // Search overlay: refresh count + scrollbar ticks from controller state.
  // Ticks rebuild only when the match set / active index / extent change — not
  // on every paint (a flood repaints at 60Hz with an open find box otherwise
  // re-mapping 1000 ticks per frame).
  if (findOpen.value) {
    findCurrent.value = controller.searchActiveIndex;
    findTotal.value = controller.searchMatchCount;
    const active = controller.searchActiveIndex;
    const key = `${controller.searchMatchCount}:${active}:${s.totalLines}`;
    if (key !== lastTicksKey) {
      lastTicksKey = key;
      searchTicks.value = controller.searchMatchList.map((m, i) => ({
        top: pad.value + lineToTrackY(m.line, s.totalLines, trackPx),
        active: i === active,
      }));
    }
  } else if (searchTicks.value.length) {
    searchTicks.value = [];
    lastTicksKey = '';
  }
}

/** Mirror the visible grid into the screen-reader DOM + announce new output.
 *  Throttled (trailing): rebuilding rows×cols text + a DOM write per PAINT is
 *  real main-thread cost under flood, and screen readers don't need 60Hz. */
let a11yTimer: ReturnType<typeof setTimeout> | null = null;
function updateA11y(_s: GridStore): void {
  if (a11yTimer != null) return;
  a11yTimer = setTimeout(() => {
    a11yTimer = null;
    const s = controller?.store;
    if (!s || !a11yMirror.value) return;
    const rows = Array.from({ length: s.rows }, (_, r) => s.visibleRow(r));
    a11yMirror.value.textContent = gridToText(rows).join('\n');
    if (s.atBottom()) {
      const cur = rowToText(s.visibleRow(s.cursor[0]));
      if (cur && cur !== lastAnnounced) {
        ariaLive.value = cur;
        lastAnnounced = cur;
      }
    }
  }, 100);
}

/** Size the canvas backing store + CSS box to a cols×rows grid at the current
 *  dpr. This CLEARS the canvas, so for a live pane it must run only at the resize
 *  commit (see `TerminalController.onResizeCommit`) — never up front, or the
 *  pre-resize frame the controller is holding is gone before it can be held. */
function sizeCanvas(cols: number, rows: number): void {
  if (!cnv) return;
  const ratio = window.devicePixelRatio || 1;
  cnv.width = Math.floor(cols * metrics.cellWidth * ratio);
  cnv.height = Math.floor(rows * metrics.cellHeight * ratio);
  cnv.style.width = `${cols * metrics.cellWidth}px`;
  cnv.style.height = `${rows * metrics.cellHeight}px`;
  // Canvas2D draws in CSS px on a device-px backing store → scale the context.
  // WebGL2 scales via gl.viewport using the dpr handed to setDpr.
  if (ctx2d) ctx2d.setTransform(ratio, 0, 0, ratio, 0, 0);
  renderer?.setDpr?.(ratio);
}

/** `hold`: keep showing the pre-resize frame until the program repaints (the
 *  pane/window resize path). Off for mount, renderer rebuild and font/padding
 *  changes, where there is no valid frame to hold. */
function applySize(opts: { hold?: boolean } = {}): void {
  if (!cnv || !controller) return;
  const ratio = window.devicePixelRatio || 1;
  // dpr changed (monitor move) → re-align cell metrics to the new device grid
  // before computing cols/rows, so glyphs stay crisp and uniform.
  const dprChanged = ratio !== metricsDpr;
  if (dprChanged) {
    // Land any held frame FIRST: it was painted at the old dpr with the old atlas,
    // and setMetrics rebuilds the atlas immediately. Never hold across a dpr change.
    controller.commitResize();
    metrics = measure();
    metricsDpr = ratio;
    controller.setMetrics(metrics);
  }
  // Archived: the grid is frozen. Keep the captured cols/rows (reflowing would
  // corrupt the stored layout), size the Canvas2D backing store to exactly those
  // cells at the current DPR, and let the pane clip/scroll. No transport resize.
  if (archived.value) {
    const s = controller.store;
    const { cols, rows } = s;
    sizeCanvas(cols, rows);
    renderer?.resize(cols, rows, 1); // renderer viewport only (no PTY behind it)
    controller.store.markAllDirty();
    controller.repaint();
    return;
  }
  // Settings hides the terminal with v-show. A font change still runs this
  // watcher, but the hidden container cannot supply a valid grid; wait for the
  // ResizeObserver fired when it becomes visible instead of resizing the PTY to
  // 1x1 and reflowing all scrollback into a single column.
  const size = gridSize();
  if (!size) return;
  const { cols, rows } = size;
  // Hold only when the grid actually changed and the dpr didn't: the daemon skips
  // no-op resizes, so there'd be no SIGWINCH, no repaint, and the hold would run
  // to the deadline with live output invisible.
  const changed = cols !== lastAppliedCols || rows !== lastAppliedRows;
  lastAppliedCols = cols;
  lastAppliedRows = rows;
  // The canvas is sized in the commit callback, not here — see `sizeCanvas`.
  controller.resize(cols, rows, { hold: (opts.hold ?? false) && changed && !dprChanged });
  // Emitted immediately (not at commit): this drives the OTHER panes' PTY resize,
  // and SIGWINCH must never wait on our paint.
  emit("resized", cols, rows);
}

/** Coalesce a burst of resizes (window/pane drag fires the ResizeObserver
 *  continuously) into one trailing apply. Each `applySize` sends a resize to the
 *  PTY → SIGWINCH; a TUI repaints on every one and — because lines reflow at the
 *  new width — miscounts its cursor-up and duplicates pre-program scrollback. We
 *  can't stop the program miscounting, but coalescing turns a drag's dozens of
 *  SIGWINCH into a single final one, so it duplicates at most once instead of N. */
let resizeTimer: ReturnType<typeof setTimeout> | null = null;
/** Held from the first observed resize until the controller commits the new
 *  grid, so anything covering the reflow (the center's slide blur) knows when
 *  the terminal has actually landed rather than guessing at a delay. */
let resizeSettlePending = false;
function markResizeSettled(): void {
  if (!resizeSettlePending) return;
  resizeSettlePending = false;
  endGridResize();
}
function scheduleResize(): void {
  if (!resizeSettlePending) {
    resizeSettlePending = true;
    beginGridResize();
  }
  if (resizeTimer != null) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    resizeTimer = null;
    applySize({ hold: true });
    // No hold was armed (archived pane, unchanged grid, hidden container) — the
    // commit callback will never fire, so release here.
    if (!controller?.isResizeHeld()) markResizeSettled();
  }, 80);
}

/** Re-measure from settings and re-apply (font family/size/line-height change). */
function applyFont(): void {
  if (!controller) return;
  metrics = measure();
  controller.setMetrics(metrics);
  applySize();
  controller.repaint();
}

/** Canvas listeners are bound in JS (not the template) so the element can be
 *  swapped on a WebGL2 context loss without losing them. */
function bindCanvasEvents(c: HTMLCanvasElement): void {
  c.addEventListener('mousedown', onCanvasMouseDown);
  c.addEventListener('mousemove', onCanvasHover);
  c.addEventListener('mouseleave', onCanvasLeave);
  c.addEventListener('contextmenu', onCanvasContextMenu);
  c.addEventListener('webglcontextlost', onContextLost as EventListener);
}
function unbindCanvasEvents(c: HTMLCanvasElement): void {
  c.removeEventListener('mousedown', onCanvasMouseDown);
  c.removeEventListener('mousemove', onCanvasHover);
  c.removeEventListener('mouseleave', onCanvasLeave);
  c.removeEventListener('contextmenu', onCanvasContextMenu);
  c.removeEventListener('webglcontextlost', onContextLost as EventListener);
}

/** Rebuild the renderer on a fresh canvas. A canvas can't change context type
 *  once one is acquired, so switching backends (setting change, or a WebGL2
 *  context loss) requires a new element. `preferWebgl` defaults to the setting;
 *  the context-loss path forces `false` to demote to Canvas2D. */
function rebuildRenderer(preferWebgl = settings.value.terminalRenderer === 'webgl'): void {
  if (!cnv || !controller) return;
  const old = cnv;
  const fresh = document.createElement('canvas');
  fresh.className = old.className;
  old.replaceWith(fresh);
  unbindCanvasEvents(old);
  renderer?.dispose();
  cnv = fresh;
  const made = createRenderer(fresh, { ...rendererOptions(), preferWebgl });
  renderer = made.renderer;
  renderKind = made.kind;
  ctx2d = made.kind === 'canvas2d' ? fresh.getContext('2d') : null;
  controller.setRenderer(made.renderer);
  bindCanvasEvents(fresh);
  controller.setMetrics(metrics);
  renderer.setFocused?.(focused);
  applySize();
  controller.store.markAllDirty();
  controller.repaint();
}

/** WebGL2 context lost → demote to Canvas2D (the correctness fallback). */
function onContextLost(e: Event): void {
  e.preventDefault(); // we rebuild ourselves; suppress the browser's auto-restore
  if (renderKind !== 'webgl2') return;
  rebuildRenderer(false);
}

/** Read the stored snapshot for `archivedTabId`, seed a GridStore, and drive a
 *  read-only controller with a no-op transport on a forced-Canvas2D renderer. No
 *  socket, no WebGL2, no PTY. Both awaits are stale-guarded so a fast tab switch
 *  never seeds the wrong pane. */
async function mountArchived(c: HTMLCanvasElement): Promise<void> {
  const requestedTabId = props.archivedTabId;
  // Emitted unconditionally up front so the host never has to reset it: every
  // archived mount lands on a definite value, including the failure paths below.
  emit('archivedPartial', false);
  let blob;
  try {
    blob = await useRpc().request.tabSnapshotRead({ id: requestedTabId! });
  } catch {
    snapshotUnavailable.value = true;
    return;
  }
  if (!isCurrentArchivedRead(requestedTabId, props.archivedTabId, disposed)) return;
  if (!blob) {
    snapshotUnavailable.value = true;
    return;
  }
  let dump;
  try {
    dump = await decodeArchivedSnapshot(blob);
  } catch {
    snapshotUnavailable.value = true;
    return;
  }
  if (!isCurrentArchivedRead(requestedTabId, props.archivedTabId, disposed)) return;

  emit('archivedPartial', isPartialArchivedSnapshot(dump));

  const store = gridStoreFromArchivedSnapshot(dump);
  const transport = new StaticGridTransport(store);
  // Force Canvas2D: an archived snapshot must allocate no WebGL2 context.
  const made = createRenderer(c, { ...rendererOptions(), preferWebgl: false });
  renderer = made.renderer;
  renderKind = 'canvas2d';
  ctx2d = c.getContext('2d');
  bindCanvasEvents(c);

  controller = new TerminalController({
    store,
    transport,
    renderer,
    metrics,
    readOnly: true,
    schedule: (cb) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(cb);
    },
  });
  controller.onAfterPaint = () => updateScrollUi();
  controller.onScroll = () => updateScrollUi();
  // No onResizeCommit: archived panes size the canvas in applySize' early return.

  applySize();
  controller.repaint();

  resizeObserver = new ResizeObserver(() => scheduleResize());
  if (container.value) resizeObserver.observe(container.value);

  // Link affordance stays active (modifier-hover underlines) — read-only doesn't
  // disable link detection/opening.
  window.addEventListener('keydown', onModifierChange);
  window.addEventListener('keyup', onModifierChange);
}

onMounted(async () => {
  const c = canvas.value;
  if (!c) return;
  cnv = c;

  metrics = measure();
  metricsDpr = window.devicePixelRatio || 1;
  bgColor.value = paletteFromTheme().background;

  // Exactly one source of truth: reject both/neither id (a live PTY and a frozen
  // snapshot are mutually exclusive).
  const hasLive = props.sessionId != null;
  const hasArchived = props.archivedTabId != null;
  if (hasLive === hasArchived) {
    console.error('GridTerminal: exactly one of sessionId / archivedTabId is required');
    return;
  }

  if (hasArchived) {
    await mountArchived(c);
    return;
  }

  const made = createRenderer(c, rendererOptions());
  renderer = made.renderer;
  renderKind = made.kind;
  ctx2d = made.kind === 'canvas2d' ? c.getContext('2d') : null;
  bindCanvasEvents(c);

  runtimeLease = acquireRetainedLiveGridRuntime(props.sessionId!)
    ?? await acquireLiveGridRuntime(props.sessionId!, async () => {
      const port = await useRpc().request.getWsPort({});
      const store = new GridStore();
      const liveSession = new GridSession(
        `ws://127.0.0.1:${port}/session/${props.sessionId}?proto=grid`,
        store,
      );
      liveSession.connect();
      return { store, session: liveSession };
    });
  if (disposed) {
    runtimeLease.release();
    runtimeLease = null;
    return;
  }
  const { store, session: liveSession } = runtimeLease.runtime;
  session = liveSession;

  controller = new TerminalController({
    store,
    transport: session,
    renderer,
    metrics,
    schedule: (cb) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(cb);
    },
  });
  controller.ime.onPreedit = () => controller?.repaint();
  controller.onAfterPaint = () => updateScrollUi();
  controller.onScroll = () => updateScrollUi(); // sub-line scrollbar tracking
  controller.onResizeCommit = (cols, rows) => {
    sizeCanvas(cols, rows);
    markResizeSettled();
  };

  registerGridSession(props.sessionId!, session, renderKind);
  if (hasRetainedGridFrame(runtimeLease)) {
    lastAppliedCols = store.cols;
    lastAppliedRows = store.rows;
    sizeCanvas(store.cols, store.rows);
    renderer.resize(store.cols, store.rows, 1);
    store.markAllDirty();
    controller.repaint();
    applySize({ hold: true });
  } else {
    applySize();
  }

  resizeObserver = new ResizeObserver(() => scheduleResize());
  if (container.value) resizeObserver.observe(container.value);

  // Modifier press/release re-evaluates the link affordance under the resting
  // pointer (window-level so it works regardless of focus).
  window.addEventListener('keydown', onModifierChange);
  window.addEventListener('keyup', onModifierChange);

  // Focus the hidden input so keystrokes flow immediately (and again on the next
  // tick, after the canvas has laid out). Gated so only the focused pane grabs it.
  if (props.autoFocus !== false) {
    focusInput();
    requestAnimationFrame(() => focusInput());
  }
  startBlink();
});

// React to terminal font settings changes.
watch(
  () => [
    settings.value.terminalFontFamily,
    settings.value.terminalFontSize,
    settings.value.terminalLineHeight,
  ],
  () => applyFont(),
);

// React to padding change (grid area resizes → recompute cols/rows + repaint).
watch(
  () => settings.value.terminalPadding,
  () => {
    applySize();
    controller?.repaint();
  },
);

// React to ligature toggle.
watch(
  () => settings.value.terminalFontLigatures,
  (on) => {
    renderer?.setLigatures?.(on);
    controller?.repaint();
  },
);

// React to bold-as-bright + minimum-contrast settings.
watch(
  () => [settings.value.terminalBoldIsBright, settings.value.terminalMinimumContrast] as const,
  ([bold, contrast]) => {
    renderer?.setBoldIsBright?.(bold);
    renderer?.setMinContrast?.(contrast);
    controller?.repaint();
  },
);

// React to a renderer-backend switch (webgl ↔ dom) by rebuilding on a fresh
// canvas (a canvas can't change context type in place).
watch(
  () => settings.value.terminalRenderer,
  () => rebuildRenderer(),
);

// React to theme changes (recompute palette + container background).
watch(themeVersion, () => {
  cachedPalette = null;
  const palette = paletteFromTheme();
  bgColor.value = palette.background;
  renderer?.setPalette?.(palette);
  controller?.repaint();
});

function onKeyDown(e: KeyboardEvent) {
  // Cmd/Ctrl+F opens the find box (don't send to the PTY).
  if (e.key === 'f' && (e.metaKey || e.ctrlKey) && !e.altKey) {
    e.preventDefault();
    openFind();
    return;
  }
  // Cmd/Ctrl+C with a selection copies: let the native `copy` event (onCopy) put
  // the text on the clipboard — do NOT preventDefault here (that suppresses the
  // copy event) and don't forward to the PTY. Ctrl+C with no selection falls
  // through to handleKeyDown so it still sends SIGINT.
  if (e.key === 'c' && (e.metaKey || e.ctrlKey) && controller?.hasSelection()) return;
  if (controller?.handleKeyDown(e)) {
    markTypingActivity();
    e.preventDefault();
  }
}

/** Native copy event: write the terminal selection (the focused hidden textarea
 *  is empty, so its default copy would clobber the clipboard with ""). */
function onCopy(e: ClipboardEvent) {
  if (!controller?.hasSelection()) return;
  e.clipboardData?.setData('text/plain', controller.copySelection());
  e.preventDefault();
}

// --- mouse selection ---
let draggingSel = false;
/** DOM button currently held & being forwarded to the app (mouse reporting), or
 *  -1 when none. Drives drag-motion + release forwarding. */
let reportBtn = -1;
function canvasXY(e: MouseEvent): { x: number; y: number } {
  const r = (cnv ?? canvas.value!).getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}
function mouseMods(e: MouseEvent) {
  return { shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey };
}
/** Resolve a link's path to an absolute path: absolute as-is, repo-relative
 *  joined with the tab cwd. Home (~) can't be expanded in the renderer. */
function resolveFilePath(value: string): string | null {
  if (value.startsWith('/')) return value;
  if (value.startsWith('~')) return null;
  if (props.cwd) return `${props.cwd.replace(/\/+$/, '')}/${value}`;
  return null;
}
/** Open a URL via the OS; a file path in the in-app editor. */
function openLink(value: string, kind: 'url' | 'path') {
  if (kind === 'url') {
    void invoke('open_external', { url: value });
    return;
  }
  const abs = resolveFilePath(value);
  if (abs) window.dispatchEvent(new CustomEvent('open-file-tab', { detail: abs }));
}
/** Underline + pointer-cursor a link under the pointer while a modifier is held
 *  (matches terminals' modifier-click affordance). Reused on pointer move AND on
 *  modifier press/release (via lastHover) so holding Cmd lights it up instantly. */
function applyLinkAffordance(x: number, y: number, mod: boolean): void {
  if (!controller || !cnv) {
    linkUnderline.value = null;
    return;
  }
  const link = mod ? controller.linkAt(x, y) : null;
  cnv.style.cursor = link ? 'pointer' : '';
  if (!link) {
    linkUnderline.value = null;
    return;
  }
  const row = Math.floor(y / metrics.cellHeight);
  const cell = controller.store.lineCells(controller.store.absLineAt(row))[link.start];
  const t = Math.max(1, Math.round(metrics.cellHeight / 16));
  linkUnderline.value = {
    left: pad.value + link.start * metrics.cellWidth,
    top: pad.value + (row + 1) * metrics.cellHeight - t - 1,
    width: link.len * metrics.cellWidth,
    height: t,
    color: cell ? resolveColor(cell.fg, themePalette(), true) : 'var(--foreground)',
  };
}
function onCanvasHover(e: MouseEvent) {
  if (!controller || draggingSel || !cnv) return;
  const { x, y } = canvasXY(e);
  lastHover = { x, y };
  // 1003 (report-all-motion): forward bare motion (no button held → button 3)
  // unless a button is already being forwarded or Shift bypasses reporting.
  if (reportBtn < 0 && !e.shiftKey && controller.store.modes.mouseMotion) {
    controller.handlePointer('move', 3, x, y, mouseMods(e));
  }
  applyLinkAffordance(x, y, e.metaKey || e.ctrlKey);
}
function onCanvasLeave() {
  lastHover = null;
  linkUnderline.value = null;
  if (cnv) cnv.style.cursor = '';
}
/** Re-evaluate the link affordance when a modifier is pressed/released while the
 *  pointer is already resting on a link (no mouse move needed). */
function onModifierChange(e: KeyboardEvent) {
  if (e.key !== 'Meta' && e.key !== 'Control') return;
  if (!lastHover) return;
  applyLinkAffordance(lastHover.x, lastHover.y, e.metaKey || e.ctrlKey);
}
function onCanvasMouseDown(e: MouseEvent) {
  focusInput();
  if (!controller) return;
  const { x, y } = canvasXY(e);
  // Cmd/Ctrl+click opens a link under the pointer (left button only).
  if (e.button === 0 && (e.metaKey || e.ctrlKey)) {
    const link = controller.linkAt(x, y);
    if (link) {
      openLink(link.value, link.kind);
      return;
    }
  }
  // App mouse reporting on → forward press/drag/release to the PTY (any button).
  // Shift bypasses reporting so the user can still select text (xterm convention).
  if (controller.store.modes.mouseReporting && !e.shiftKey) {
    controller.handlePointer('down', e.button, x, y, mouseMods(e));
    reportBtn = e.button;
    window.addEventListener('mousemove', onReportMove);
    window.addEventListener('mouseup', onReportUp);
    return;
  }
  // Local selection (left button only).
  if (e.button !== 0) return;
  if (e.detail === 2) {
    controller.selectWordAt(x, y);
    return;
  }
  controller.selectionStart(x, y);
  draggingSel = true;
  window.addEventListener('mousemove', onSelMove);
  window.addEventListener('mouseup', onSelUp);
}
/** Forward held-button motion to the app (drag, mode 1002 — or 1003). Mode 1000
 *  (click-only) gets press/release but no motion. */
function onReportMove(e: MouseEvent) {
  if (!controller || reportBtn < 0) return;
  const m = controller.store.modes;
  if (!m.mouseDrag && !m.mouseMotion) return;
  const { x, y } = canvasXY(e);
  controller.handlePointer('move', reportBtn, x, y, mouseMods(e));
}
function onReportUp(e: MouseEvent) {
  if (controller && reportBtn >= 0) {
    const { x, y } = canvasXY(e);
    controller.handlePointer('up', reportBtn, x, y, mouseMods(e));
  }
  reportBtn = -1;
  window.removeEventListener('mousemove', onReportMove);
  window.removeEventListener('mouseup', onReportUp);
}
/** With app mouse reporting on, a right-click is forwarded to the PTY (button 2)
 *  — suppress both the native menu and our reka-ui context menu (stopPropagation
 *  keeps the event from the ContextMenuTrigger on the parent wrapper). Shift
 *  bypasses reporting, so the menu still opens then. */
function onCanvasContextMenu(e: MouseEvent) {
  if (controller?.store.modes.mouseReporting && !e.shiftKey) {
    e.preventDefault();
    e.stopPropagation();
  }
}
function onSelMove(e: MouseEvent) {
  if (!draggingSel || !controller) return;
  const { x, y } = canvasXY(e);
  controller.selectionUpdate(x, y);
}
function onSelUp() {
  draggingSel = false;
  controller?.selectionEnd();
  window.removeEventListener('mousemove', onSelMove);
  window.removeEventListener('mouseup', onSelUp);
}
function onInput(e: Event) {
  const ta = e.target as HTMLTextAreaElement;
  if (controller && !controller.ime.composing && ta.value) {
    controller.handleText(ta.value);
    markTypingActivity();
    ta.value = '';
  }
}
function onCompositionStart() {
  composing.value = true;
  controller?.ime.start();
}
function onCompositionUpdate(e: CompositionEvent) {
  controller?.ime.update(e.data ?? '');
}
function onCompositionEnd(e: CompositionEvent) {
  composing.value = false;
  const text = e.data ?? '';
  controller?.ime.end(text);
  if (text) markTypingActivity();
  if (hiddenInput.value) hiddenInput.value.value = '';
}
function onWheel(e: WheelEvent) {
  // Archived grids are frozen at capture width: a horizontal gesture scrolls the
  // pane natively (don't preventDefault), while vertical still drives the virtual
  // scrollback below.
  if (archived.value && Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
  e.preventDefault();
  if (!controller) return;
  // Scrolling shifts cell positions → the hover underline would be stale.
  linkUnderline.value = null;
  lastHover = null;
  // Normalize to pixels (deltaMode), then to fractional rows — passed straight
  // through so the scroll position tracks the trackpad 1:1 (its own OS inertia
  // included) instead of being quantized to whole rows here.
  const ch = metrics.cellHeight;
  let px = e.deltaY;
  if (e.deltaMode === 1) px *= ch; // DOM_DELTA_LINE
  else if (e.deltaMode === 2) px *= ch * controller.store.rows; // DOM_DELTA_PAGE
  // deltaY > 0 = scroll down (toward newer) → negative rows-toward-history.
  // Coordinates via the canvas rect: e.offsetX/Y are relative to e.target (wrong
  // over the scrollbar/underline overlays) and the canvas rect already excludes
  // the padding, so no pad subtraction here.
  const rect = (cnv ?? canvas.value)?.getBoundingClientRect();
  const cx = rect ? e.clientX - rect.left : 0;
  const cy = rect ? e.clientY - rect.top : 0;
  controller.handleWheel(-px / ch, cx, cy);
}
function onPaste(e: ClipboardEvent) {
  const text = e.clipboardData?.getData('text');
  if (text) {
    e.preventDefault();
    controller?.handlePaste(text);
    markTypingActivity();
  }
}
function focusInput() {
  hiddenInput.value?.focus();
}

// --- cursor blink + focus ---
let blinkTimer = 0;
let blinkOn = true;
let focused = true;
const BLINK_MS = 530;
const TYPING_IDLE_MS = 700;
let typingUntil = 0;
let typingTimer: ReturnType<typeof setTimeout> | null = null;

function repaintCursorRow() {
  if (!controller) return;
  controller.store.dirtyRows.add(controller.store.cursorRow());
  controller.repaint();
}

function setCursorVisible(visible: boolean) {
  if (!renderer || renderer.cursorVisible === visible) return;
  renderer.cursorVisible = visible;
  repaintCursorRow();
}

function markTypingActivity() {
  typingUntil = performance.now() + TYPING_IDLE_MS;
  setCursorVisible(true);
  if (typingTimer != null) clearTimeout(typingTimer);
  typingTimer = setTimeout(() => {
    typingTimer = null;
    if (performance.now() < typingUntil || !renderer || !controller) return;
    if (focused && controller.store.cursorBlink) setCursorVisible(blinkOn);
  }, TYPING_IDLE_MS);
}

function startBlink() {
  stopBlink();
  blinkTimer = window.setInterval(() => {
    if (!renderer || !controller) return;
    const s = controller.store;
    // Steady (solid) when unfocused or blink disabled.
    if (!focused || !s.cursorBlink) {
      setCursorVisible(true);
      return;
    }
    // User input forces a solid cursor without touching blinkOn, so typing does
    // not restart or phase-shift the underlying blink animation.
    if (performance.now() < typingUntil) {
      setCursorVisible(true);
      return;
    }
    blinkOn = !blinkOn;
    renderer.cursorVisible = blinkOn;
    // paint() only redraws dirty rows; when idle there are none, so the cursor
    // toggle would be invisible — mark the cursor's render row dirty so it repaints.
    s.dirtyRows.add(s.cursorRow());
    controller.repaint();
  }, BLINK_MS);
}
function stopBlink() {
  if (blinkTimer) clearInterval(blinkTimer);
  blinkTimer = 0;
  if (typingTimer != null) clearTimeout(typingTimer);
  typingTimer = null;
}
function onFocus() {
  focused = true;
  renderer?.setFocused?.(true);
  controller?.repaint();
}
function onBlur() {
  focused = false;
  renderer?.setFocused?.(false);
  controller?.repaint();
}

// --- scrollbar drag ---
let dragStartY = 0;
let dragStartTop = 0;
function onSliderDown(e: PointerEvent) {
  e.preventDefault();
  (e.target as HTMLElement).setPointerCapture(e.pointerId);
  dragStartY = e.clientY;
  dragStartTop = sliderTop.value - pad.value; // position within the track
  sliderDragging.value = true;
  window.addEventListener('pointermove', onSliderMove);
  window.addEventListener('pointerup', onSliderUp);
}
function onSliderMove(e: PointerEvent) {
  if (!controller) return;
  const trackPx = controller.store.rows * metrics.cellHeight;
  const pos = dragStartTop + (e.clientY - dragStartY);
  const offset = positionToScrollOffset(
    pos,
    sliderHeight.value,
    trackPx,
    controller.store.rows,
    controller.store.totalLines,
  );
  controller.scrollTo(offset);
}
function onSliderUp() {
  sliderDragging.value = false;
  window.removeEventListener('pointermove', onSliderMove);
  window.removeEventListener('pointerup', onSliderUp);
}
function jumpToBottom() {
  controller?.jumpToBottom();
  focusInput();
}
function openFind(): void {
  if (searchDebounce != null) { clearTimeout(searchDebounce); searchDebounce = null; }
  findOpen.value = true;
  // Seed with the current selection if any (VS Code behavior).
  const sel = controller?.copySelection().split('\n')[0] ?? '';
  if (sel) findQuery.value = sel;
  void nextTick(() => findBox.value?.focus());
  if (findQuery.value) runSearch();
}
function closeFind(): void {
  findOpen.value = false;
  if (searchDebounce != null) { clearTimeout(searchDebounce); searchDebounce = null; }
  controller?.clearSearch();
  findCurrent.value = -1;
  findTotal.value = 0;
  searchTicks.value = [];
  focusInput();
}
function runSearch(): void {
  controller?.search(findQuery.value, findCaseSensitive.value);
  refreshFindState();
}
function onFindQuery(v: string): void {
  findQuery.value = v;
  if (searchDebounce != null) clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => { searchDebounce = null; runSearch(); }, 120);
}
function onFindCase(v: boolean): void {
  findCaseSensitive.value = v;
  runSearch();
}
function findNext(): void { controller?.searchNext(); refreshFindState(); }
function findPrev(): void { controller?.searchPrev(); refreshFindState(); }
/** Pull match count/active from the controller into the box. Called after each
 *  nav; the async result also refreshes via updateScrollUi (onAfterPaint). */
function refreshFindState(): void {
  if (!controller) return;
  findCurrent.value = controller.searchActiveIndex;
  findTotal.value = controller.searchMatchCount;
}

onBeforeUnmount(() => {
  disposed = true;
  if (props.sessionId) unregisterGridSession(props.sessionId);
  cancelAnimationFrame(raf);
  stopBlink();
  window.removeEventListener('pointermove', onSliderMove);
  window.removeEventListener('pointerup', onSliderUp);
  window.removeEventListener('mousemove', onSelMove);
  window.removeEventListener('mouseup', onSelUp);
  window.removeEventListener('mousemove', onReportMove);
  window.removeEventListener('mouseup', onReportUp);
  window.removeEventListener('keydown', onModifierChange);
  window.removeEventListener('keyup', onModifierChange);
  if (cnv) unbindCanvasEvents(cnv);
  resizeObserver?.disconnect();
  if (resizeTimer != null) clearTimeout(resizeTimer);
  markResizeSettled();
  if (searchDebounce != null) clearTimeout(searchDebounce);
  if (a11yTimer != null) clearTimeout(a11yTimer);
  if (!controller) {
    renderer?.dispose();
  } else if (archived.value) {
    controller.dispose();
  } else {
    controller.dispose({ disposeTransport: false });
  }
  if (!archived.value) {
    runtimeLease?.release();
    runtimeLease = null;
  }
  controller = null;
  session = null;
  renderer = null;
  cnv = null;
  ctx2d = null;
});

/** Copy the current selection to the clipboard (context-menu Copy). */
function copySelection(): void {
  const text = controller?.copySelection() ?? '';
  if (text) void navigator.clipboard.writeText(text);
}

/** Read the clipboard and paste into the PTY (context-menu Paste). */
function paste(): void {
  void navigator.clipboard.readText().then((t) => {
    if (t) controller?.handlePaste(t);
  });
}

defineExpose({
  /** Send text to the PTY (used for drag-dropped paths + text injection). */
  sendText: (t: string) => controller?.handleText(t),
  focus: () => focusInput(),
  copySelection,
  paste,
});
</script>

<template>
  <div
    ref="container"
    class="group relative h-full w-full overflow-hidden"
    :style="{ background: bgColor, padding: `${pad}px` }"
    @mousedown.prevent="focusInput"
    @wheel="onWheel"
  >
    <!-- Archived grids are frozen at capture width; wrap the canvas in a
         horizontal scroller so a session wider than the pane can scroll sideways.
         Live mode uses `contents` so the canvas stays a direct child (unchanged).
         Overlays stay on the outer container so they don't drift when scrolled. -->
    <div :class="archived ? 'h-full w-full overflow-x-auto overflow-y-hidden' : 'contents'">
      <!-- Mouse + webglcontextlost listeners are bound in JS (bindCanvasEvents) so
           the element can be swapped on a context loss. -->
      <canvas ref="canvas" class="block" />
    </div>
    <!-- Link hover underline (modifier held over a link). -->
    <div
      v-if="linkUnderline"
      class="pointer-events-none absolute"
      :style="{
        left: `${linkUnderline.left}px`,
        top: `${linkUnderline.top}px`,
        width: `${linkUnderline.width}px`,
        height: `${linkUnderline.height}px`,
        background: linkUnderline.color,
      }"
    />
    <!-- Custom scrollbar (canvas has no native one). -->
    <div
      v-if="sliderVisible"
      class="absolute right-0.5 w-1.5 cursor-pointer rounded-full bg-foreground/25 opacity-0 transition-opacity hover:bg-foreground/40 group-hover:opacity-100"
      :class="{ 'opacity-100': sliderDragging }"
      :style="{ top: `${sliderTop}px`, height: `${sliderHeight}px` }"
      @pointerdown="onSliderDown"
    />
    <!-- Jump-to-latest pill, shown when output arrives while scrolled up. -->
    <button
      v-if="showJump"
      class="absolute bottom-2 right-3 rounded-full bg-neutral-300 px-2 py-1 text-xs text-neutral-900 shadow hover:bg-neutral-200 dark:bg-neutral-400 dark:text-neutral-900 dark:hover:bg-neutral-300"
      @click="jumpToBottom"
    >
      ↓ Latest
    </button>
    <!-- Archived read failure: keep the pane visible (un-archive controls live in
         TerminalPane) but tell the user the snapshot couldn't be restored. -->
    <div
      v-if="snapshotUnavailable"
      class="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-muted-foreground"
    >
      Archived snapshot unavailable
    </div>
    <!-- Hidden keyboard/IME input: live sessions only (archived accepts none). -->
    <textarea
      v-if="!archived"
      ref="hiddenInput"
      class="terminal-input absolute resize-none overflow-hidden border-0 p-0 outline-none"
      :class="composing ? 'z-10 whitespace-pre' : 'h-px w-px opacity-0'"
      :style="
        composing
          ? {
              left: `${caretLeft}px`,
              top: `${caretTop}px`,
              width: `${caretWidth}px`,
              height: `${metrics?.cellHeight ?? 16}px`,
              font: `${metrics?.fontSize ?? 13}px ${metrics?.fontFamily ?? 'monospace'}`,
              color: 'var(--foreground)',
              background: bgColor,
            }
          : { left: '0', top: '0' }
      "
      aria-label="Terminal input"
      autocapitalize="off"
      autocomplete="off"
      autocorrect="off"
      spellcheck="false"
      @keydown="onKeyDown"
      @copy="onCopy"
      @input="onInput"
      @paste="onPaste"
      @focus="onFocus"
      @blur="onBlur"
      @compositionstart="onCompositionStart"
      @compositionupdate="onCompositionUpdate"
      @compositionend="onCompositionEnd"
    />
    <!-- Screen-reader mirror of the visible grid (offscreen but readable). -->
    <div
      ref="a11yMirror"
      class="sr-only"
      role="document"
      aria-label="Terminal contents"
      aria-readonly="true"
    />
    <div class="sr-only" aria-live="polite" aria-atomic="true">{{ ariaLive }}</div>
    <!-- Search match ticks on the scrollbar track (find open + matches). -->
    <div
      v-for="(t, i) in searchTicks"
      :key="i"
      class="pointer-events-none absolute right-0.5 h-0.5 w-1.5 rounded-full"
      :class="t.active ? 'bg-amber-400' : 'bg-amber-400/50'"
      :style="{ top: `${t.top}px` }"
    />
    <!-- Find box (top-right overlay). -->
    <TerminalFindBox
      v-if="findOpen"
      ref="findBox"
      :query="findQuery"
      :case-sensitive="findCaseSensitive"
      :current="findCurrent"
      :total="findTotal"
      @update:query="onFindQuery"
      @update:case-sensitive="onFindCase"
      @next="findNext"
      @prev="findPrev"
      @close="closeFind"
    />
  </div>
</template>
