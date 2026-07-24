// Browser-side harness: real GridStore + WebGL2Renderer (or Canvas2D), driven
// by Playwright via window.__harness. Mirrors GridTerminal.vue's canvas setup.
import { GridStore } from '../../src/lib/terminal/GridStore';
import { createRenderer } from '../../src/lib/terminal/createRenderer';
import { defaultPalette } from '../../src/lib/terminal/palette';
import { gridStoreFromArchivedSnapshot } from '../../src/lib/terminal/archivedSnapshot';
import { StaticGridTransport } from '../../src/lib/terminal/StaticGridTransport';
import { TerminalController } from '../../src/lib/terminal/TerminalController';
import type { FontMetrics, TerminalRenderer } from '../../src/lib/terminal/renderer';
import type { DeltaFrame, SyncFrame } from '../../src/lib/terminal/gridProtocol';
import type { WebGL2Renderer } from '../../src/lib/terminal/WebGL2Renderer';
import {
  archivedFixture,
  cell,
  floodFrames,
  searchHighlights,
  sparseFrames,
  stylesFixture,
  syncFrame,
  truecolorFrames,
  uniqueGlyphFrames,
} from './scenarios';

// ---- Archived-mode instrumentation ----------------------------------------
// Counts survive for the lifetime of the page (each Playwright test reloads
// the page, so this never leaks across tests). `mountArchived` resets both to
// 0 immediately before it runs so the counts it reports are scoped to exactly
// that call, regardless of what other harness functions on this same page did
// before it (e.g. a webgl2 readback in paintFrames).
let webglRequests = 0;
let websocketRequests = 0;

const nativeGetContext = HTMLCanvasElement.prototype.getContext;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(HTMLCanvasElement.prototype as any).getContext = function (
  this: HTMLCanvasElement,
  type: string,
  ...rest: unknown[]
) {
  if (type === 'webgl2') webglRequests++;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (nativeGetContext as any).call(this, type, ...rest);
};

/** Counting stand-in for `window.WebSocket` — the archived path must never
 *  construct one (`StaticGridTransport` opens no socket). Present so a
 *  regression that accidentally wires a live `GridSession` into archived mode
 *  is caught here instead of only in manual QA. */
class CountingWebSocket {
  constructor(..._args: unknown[]) {
    websocketRequests++;
  }
  close(): void {}
  send(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).WebSocket = CountingWebSocket;

interface BenchStats {
  frames: number;
  avgMs: number;
  maxMs: number;
  p95Ms: number;
  kind: string;
}

const METRICS: FontMetrics = {
  cellWidth: 9,
  cellHeight: 18,
  baseline: 14,
  fontFamily: 'Menlo, monospace',
  fontSize: 14,
};

let store: GridStore;
let renderer: TerminalRenderer;
let kind = 'none';
let canvas: HTMLCanvasElement;

function setup(cols: number, rows: number, opts: { dpr?: number; ligatures?: boolean } = {}): string {
  document.querySelector('canvas')?.remove();
  renderer?.dispose();
  const dpr = opts.dpr ?? 1;
  canvas = document.createElement('canvas');
  canvas.width = Math.floor(cols * METRICS.cellWidth * dpr);
  canvas.height = Math.floor(rows * METRICS.cellHeight * dpr);
  canvas.style.width = `${cols * METRICS.cellWidth}px`;
  canvas.style.height = `${rows * METRICS.cellHeight}px`;
  document.body.appendChild(canvas);
  const made = createRenderer(canvas, {
    metrics: METRICS,
    palette: defaultPalette,
    ligatures: opts.ligatures ?? false,
    boldIsBright: false,
    minContrast: 1,
    preferWebgl: true,
  });
  renderer = made.renderer;
  kind = made.kind;
  renderer.setDpr?.(dpr);
  store = new GridStore();
  store.applySync(syncFrame(cols, rows));
  return kind;
}

function paintFrames(frames: (DeltaFrame | SyncFrame)[]): BenchStats {
  const times: number[] = [];
  for (const f of frames) {
    if (f.type === 'sync') store.applySync(f);
    else store.applyDelta(f);
    const t0 = performance.now();
    renderer.paint(store);
    times.push(performance.now() - t0);
  }
  // Force the GPU to actually finish so paint cost isn't deferred out of the
  // measurement (readback is a full pipeline sync).
  const gl = canvas.getContext('webgl2');
  if (gl) gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
  const sorted = [...times].sort((a, b) => a - b);
  return {
    frames: times.length,
    avgMs: times.reduce((a, b) => a + b, 0) / times.length,
    maxMs: sorted[sorted.length - 1],
    p95Ms: sorted[Math.floor(sorted.length * 0.95)],
    kind,
  };
}

const api = {
  setup,

  bench(scenario: string, cols: number, rows: number, n: number): BenchStats {
    setup(cols, rows);
    // Warm-up: first paint rasterizes the glyph working set into the atlas.
    const warm =
      scenario === 'flood' ? floodFrames(cols, rows, 3)
      : scenario === 'sparse' ? sparseFrames(cols, rows, 3)
      : scenario === 'truecolor' ? truecolorFrames(cols, rows, 3)
      : scenario === 'uniqueGlyphs' ? uniqueGlyphFrames(cols, rows, 3)
      : null;
    if (!warm) throw new Error(`unknown scenario ${scenario}`);
    paintFrames(warm);
    const frames =
      scenario === 'flood' ? floodFrames(cols, rows, n)
      : scenario === 'sparse' ? sparseFrames(cols, rows, n)
      : scenario === 'truecolor' ? truecolorFrames(cols, rows, n)
      : uniqueGlyphFrames(cols, rows, n);
    return paintFrames(frames);
  },

  benchSearch(cols: number, rows: number, matches: number, n: number): BenchStats {
    setup(cols, rows);
    paintFrames(floodFrames(cols, rows, 1));
    renderer.setSearchMatches?.(searchHighlights(rows, matches), 0);
    const times: number[] = [];
    for (let i = 0; i < n; i++) {
      store.markAllDirty();
      const t0 = performance.now();
      renderer.paint(store);
      times.push(performance.now() - t0);
    }
    const sorted = [...times].sort((a, b) => a - b);
    return {
      frames: n,
      avgMs: times.reduce((a, b) => a + b, 0) / n,
      maxMs: sorted[n - 1],
      p95Ms: sorted[Math.floor(n * 0.95)],
      kind,
    };
  },

  /** Render the style-matrix fixture (for pixel goldens). */
  renderStyles(cols: number, rows: number, dpr: number): string {
    const k = setup(cols, rows, { dpr });
    store.applySync(stylesFixture(cols, rows));
    renderer.paint(store);
    return k;
  },

  /** Probe: render a single ligature run with an OUTSIZED font in a tight slot
   *  (forces ascender/descender to overflow the shelf), then scan the run-atlas
   *  canvas BELOW shelf 0 for lit pixels. Without the raster clip, overflow
   *  bleeds into shelf 1's territory → stray texels (the speckle mechanism). */
  runAtlasOverflowBleed(dpr: number, fontSize: number, cellH: number) {
    document.querySelector('canvas')?.remove();
    renderer?.dispose();
    canvas = document.createElement('canvas');
    const probe = document.createElement('canvas').getContext('2d')!;
    probe.font = `${fontSize}px monospace`;
    const cw = Math.max(1, Math.round(probe.measureText('M').width * dpr)) / dpr;
    const m: FontMetrics = {
      cellWidth: cw, cellHeight: cellH,
      baseline: Math.round((cellH - fontSize) / 2 + fontSize * 0.8),
      fontFamily: 'monospace', fontSize,
    };
    const cols = 40, rows = 4;
    canvas.width = Math.floor(cols * cw * dpr);
    canvas.height = Math.floor(rows * cellH * dpr);
    document.body.appendChild(canvas);
    const made = createRenderer(canvas, {
      metrics: m, palette: defaultPalette, ligatures: true,
      boldIsBright: false, minContrast: 1, preferWebgl: true,
    });
    renderer = made.renderer; kind = made.kind;
    renderer.setDpr?.(dpr);
    store = new GridStore();
    store.applySync(syncFrame(cols, rows));
    const txt = 'gjpqygjQÅ{}|gjpqy'; // deep descenders + tall accent, no spaces → 1 run
    store.applySync(syncFrame(cols, rows, [
      { line: 0, startCol: 0, cells: [...txt].map((c) => cell(c)), wrapped: false },
    ]));
    renderer.paint(store);
    const { canvas: rc, rowH, slotH } = (renderer as unknown as WebGL2Renderer).__debugRunCanvas();
    const rctx = rc.getContext('2d')!;
    // Shelf 0 occupies rows [0, rowH). Its content slot is [0, slotH). Scan from
    // slotH downward into the pad + shelf 1: with the clip, nothing here.
    const scanTop = slotH;
    const scanH = Math.min(rowH * 2, rc.height - scanTop);
    const img = rctx.getImageData(0, scanTop, rc.width, scanH).data;
    let lit = 0;
    const samples: number[][] = [];
    for (let p = 3; p < img.length; p += 4) {
      if (img[p] > 16) {
        lit++;
        if (samples.length < 12) {
          const idx = (p - 3) / 4;
          samples.push([idx % rc.width, scanTop + Math.floor(idx / rc.width), img[p]]);
        }
      }
    }
    return { kind, rowH, slotH, scanTop, runCanvasH: rc.height, lit, samples };
  },

  /** Render styles with search highlights + selection overlays. */
  renderOverlays(cols: number, rows: number, dpr: number): string {
    const k = setup(cols, rows, { dpr });
    store.applySync(stylesFixture(cols, rows));
    renderer.setSearchMatches?.(
      [
        { line: 0, col: 0, len: 5 },
        { line: 1, col: 2, len: 4 },
      ],
      0,
    );
    renderer.setSelection({ startLine: 13, startCol: 0, endLine: 14, endCol: 20 });
    renderer.paint(store);
    return k;
  },

  // ---- archived-snapshot scenario: proves Canvas2D-only, no-socket replay --
  // Reset per-call so counts reported below are scoped to this mount, not
  // whatever else ran on this page earlier.
  webglRequests: 0,
  websocketRequests: 0,
  copiedText: '',
  totalLines: 0,

  /** Seed a GridStore from an archived snapshot dump (Task 4's replay path),
   *  drive it through the same read-only TerminalController + StaticGridTransport
   *  GridTerminal.vue uses for archived tabs, force Canvas2D (`preferWebgl:
   *  false`), scroll to the oldest retained row, select it, and copy. Mirrors
   *  `mountArchived()` in GridTerminal.vue. */
  mountArchived(cols: number, rows: number): string {
    webglRequests = 0;
    websocketRequests = 0;

    document.querySelector('canvas')?.remove();
    renderer?.dispose();
    canvas = document.createElement('canvas');
    canvas.width = cols * METRICS.cellWidth;
    canvas.height = rows * METRICS.cellHeight;
    canvas.style.width = `${cols * METRICS.cellWidth}px`;
    canvas.style.height = `${rows * METRICS.cellHeight}px`;
    document.body.appendChild(canvas);

    const dump = archivedFixture(cols, rows);
    store = gridStoreFromArchivedSnapshot(dump);
    const transport = new StaticGridTransport(store);
    const made = createRenderer(canvas, {
      metrics: METRICS,
      palette: defaultPalette,
      ligatures: false,
      boldIsBright: false,
      minContrast: 1,
      preferWebgl: false, // archived: must never request a webgl2 context
    });
    renderer = made.renderer;
    kind = made.kind;

    const controller = new TerminalController({
      store,
      transport,
      renderer,
      metrics: METRICS,
      readOnly: true,
      schedule: (cb) => cb(), // synchronous in the harness
    });
    controller.repaint();

    // Scroll to the very top of scrollback: the oldest history row lands on
    // render row 0 once scrollOffset === maxScrollOffset.
    controller.scrollTo(store.maxScrollOffset());
    controller.repaint();

    // Select the full width of render row 0 (the oldest line) and copy it.
    controller.selectionStart(0, 0);
    controller.selectionUpdate(canvas.width, 0);
    controller.selectionEnd();

    api.webglRequests = webglRequests;
    api.websocketRequests = websocketRequests;
    api.copiedText = controller.copySelection();
    api.totalLines = store.totalLines;
    return kind;
  },
};

declare global {
  interface Window {
    __harness: typeof api;
  }
}
window.__harness = api;
