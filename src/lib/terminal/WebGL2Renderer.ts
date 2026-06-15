// WebGL2 terminal renderer. Glyphs are rasterized on demand to an atlas canvas
// (packed by AtlasPacker) and uploaded to a texture; the screen is
// drawn as instanced unit quads — per-row instance lists built by buildRow
// (renderModel.ts), packed into per-layer GL buffers, one drawArraysInstanced
// per layer. This is the perf path; Canvas2DRenderer is the correctness
// fallback used on context loss. The GL itself is exercised live (not in unit
// tests); the geometry it draws is covered by renderModel tests and the
// pixel-golden renderer tests.

import type { Cell } from './gridProtocol';
import { FLAG } from './gridProtocol';
import { drawBoxGlyph, isBoxGlyph } from './boxGlyph';
import type { GridStore } from './GridStore';
import { AtlasPacker, glyphKey } from './glyphAtlas';
import { defaultPalette, type Palette } from './palette';
import type { FontMetrics, SearchHighlight, SelectionRange, TerminalRenderer } from './renderer';
import {
  buildRow,
  cssToRgba,
  GLYPH_F,
  InstanceList,
  makeRowModel,
  RECT_F,
  type Rgba,
  type RowBuildCtx,
  type RowModel,
} from './renderModel';

/** Device-px padding around each packed entry (NEAREST sampling: 1px stops
 *  neighbor bleed; 2px guards the dpr-scaled half-texel case). */
const ATLAS_PAD = 2;
const ATLAS_INITIAL = 512;

const RECT_VS = `#version 300 es
layout(location=0) in vec2 a_corner;       // unit quad 0..1, divisor 0
layout(location=1) in vec4 a_rect;         // x,y,w,h (CSS px), divisor 1
layout(location=2) in vec4 a_color;        // divisor 1
uniform vec2 u_viewport;
out vec4 v_color;
void main() {
  vec2 pos = a_rect.xy + a_corner * a_rect.zw;
  vec2 clip = (pos / u_viewport) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_color = a_color;
}`;
const RECT_FS = `#version 300 es
precision mediump float;
in vec4 v_color; out vec4 o;
void main() { o = v_color; }`;

const GLYPH_VS = `#version 300 es
layout(location=0) in vec2 a_corner;
layout(location=1) in vec4 a_rect;
layout(location=2) in vec4 a_uvrect;       // u0,v0,u1,v1, divisor 1
layout(location=3) in vec4 a_color;
uniform vec2 u_viewport;
out vec2 v_uv; out vec4 v_color;
void main() {
  vec2 pos = a_rect.xy + a_corner * a_rect.zw;
  vec2 clip = (pos / u_viewport) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_uv = mix(a_uvrect.xy, a_uvrect.zw, a_corner);
  v_color = a_color;
}`;
const GLYPH_FS = `#version 300 es
precision mediump float;
in vec2 v_uv; in vec4 v_color; out vec4 o;
uniform sampler2D u_atlas;
void main() {
  float a = texture(u_atlas, v_uv).a;
  o = vec4(v_color.rgb, v_color.a * a);
}`;
// Color-glyph (emoji) fragment shader: the atlas holds the glyph's OWN colors
// (Apple Color Emoji etc.), so sample full RGBA straight through instead of
// tinting an alpha mask with the cell fg (which flattens emoji to a silhouette).
const EMOJI_FS = `#version 300 es
precision mediump float;
in vec2 v_uv; in vec4 v_color; out vec4 o;
uniform sampler2D u_atlas;
void main() { o = texture(u_atlas, v_uv); }`;

/** BMP codepoints with Emoji_Presentation=Yes (Unicode emoji-data.txt) that sit
 *  below the U+1F000 emoji blocks, inside the otherwise text-presented
 *  U+2600–27BF symbol span. These render as COLOR emoji by default (no VS16):
 *  ✅ ❌ ✨ ⭐ ⏰ ⚡ … So they must take the color path even though their
 *  neighbors (✂ ❤ ✶ ✳ ☀, Emoji_Presentation=No) stay tinted text. */
const BMP_EMOJI_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x231a, 0x231b], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3],
  [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f],
  [0x2693, 0x2693], [0x26a1, 0x26a1], [0x26aa, 0x26ab], [0x26bd, 0x26be],
  [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea],
  [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd],
  [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728], [0x274c, 0x274c],
  [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797],
  [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50],
  [0x2b55, 0x2b55], [0x3030, 0x3030], [0x303d, 0x303d], [0x3297, 0x3297],
  [0x3299, 0x3299],
];
const BMP_EMOJI = new Set<number>();
for (const [lo, hi] of BMP_EMOJI_RANGES) for (let c = lo; c <= hi; c++) BMP_EMOJI.add(c);

/** Codepoints whose font glyph is colored (emoji) — rendered straight from the
 *  atlas, not tinted. The high emoji blocks are emoji-presentation by default
 *  (no font text glyph); BMP_EMOJI adds the default-presentation symbols below
 *  them. The rest of the symbol/dingbat span (U+2600–27BF: ☀ ✂ ✶ ✳ …) is
 *  EXCLUDED: those are TEXT-presentation by default and programs (e.g. Claude
 *  Code's spinner stars) color them via SGR, so they must be tinted by the cell
 *  fg — routing them here renders them as an untinted white mask. A bare such
 *  symbol gets emoji presentation only via VS16 (see isEmojiCell), the correct
 *  Unicode rule. */
export function isEmojiCp(cp: number): boolean {
  return (
    (cp >= 0x1f000 && cp <= 0x1faff) || // emoticons, symbols & pictographs, transport, supplemental, extended-A
    (cp >= 0x1f1e6 && cp <= 0x1f1ff) || // regional indicators (flags)
    BMP_EMOJI.has(cp)
  );
}

/** A cell renders as a color emoji if its base cp is in an emoji-default block,
 *  or a VS16 (U+FE0F) combining mark forces emoji presentation of an otherwise
 *  text-presented symbol (❤ + FE0F → ❤️). Text-presented symbols without VS16
 *  stay on the tinted text path so their SGR color is honored. */
export function isEmojiCell(cell: Cell): boolean {
  return isEmojiCp(cell.cp) || (cell.zw?.includes(0xfe0f) ?? false);
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error(`shader: ${gl.getShaderInfoLog(sh)}`);
  }
  return sh;
}

function program(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(`program: ${gl.getProgramInfoLog(p)}`);
  }
  return p;
}

/** Union (x,y,w,h) into dirty rect `r` in place; fresh rect when `r` is null.
 *  Shared by both atlases — one upload per paint covers the union. */
function unionRect(
  r: { x: number; y: number; w: number; h: number } | null,
  x: number,
  y: number,
  w: number,
  h: number,
): { x: number; y: number; w: number; h: number } {
  if (!r) return { x, y, w, h };
  const x1 = Math.max(r.x + r.w, x + w);
  const y1 = Math.max(r.y + r.h, y + h);
  r.x = Math.min(r.x, x);
  r.y = Math.min(r.y, y);
  r.w = x1 - r.x;
  r.h = y1 - r.y;
  return r;
}

/** One draw layer: a persistent GL buffer + VAO + a CPU pack list. */
interface Layer {
  list: InstanceList;
  buf: WebGLBuffer;
  vao: WebGLVertexArrayObject;
}

export class WebGL2Renderer implements TerminalRenderer {
  private gl: WebGL2RenderingContext;
  private metrics: FontMetrics;
  private palette: Palette;
  private rectProg: WebGLProgram;
  private glyphProg: WebGLProgram;
  private emojiProg: WebGLProgram;
  private atlasTex: WebGLTexture;
  private atlasCanvas: HTMLCanvasElement | OffscreenCanvas;
  private atlasCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  private atlas!: AtlasPacker; // created in rebuildAtlas (needs slotH)
  /** Atlas canvas region needing upload this paint (device px), or null. */
  private atlasDirtyRect: { x: number; y: number; w: number; h: number } | null = null;
  /** Full texImage2D needed (growth / reset / first upload). */
  private atlasFullUpload = true;
  /** Set when allocate() returned null this paint → grow before next paint. */
  private atlasWantsGrow = false;
  private dpr = 1;
  private selection: SelectionRange | null = null;
  private searchMatches: SearchHighlight[] | null = null;
  private searchActive = -1;
  /** Map bold ANSI 0-7 fg to the bright 8-15 variant. */
  private boldIsBright = false;
  /** Minimum fg/bg contrast ratio to enforce (1 = off). */
  private minContrast = 1;
  /** Whether the terminal is focused — drives the hollow cursor when blurred. */
  private cursorFocused = true;
  /** Draw contiguous same-style runs as one shaped string so font ligatures form. */
  private ligatures = false;
  cursorVisible = true;

  // Run-image atlas (ligatures): shaped multi-cell strings are rasterized once
  // (white mask) and packed by a second AtlasPacker; color is per-instance.
  // Keyed by style+text (color-independent), so blue and red `=>` share an image.
  private runCanvas: HTMLCanvasElement;
  private runCtx: CanvasRenderingContext2D;
  private runTex: WebGLTexture;
  private runAtlas!: AtlasPacker; // created in resetRunAtlas
  /** Run-atlas canvas region needing upload this paint (device px), or null. */
  private runDirtyRect: { x: number; y: number; w: number; h: number } | null = null;
  /** Full texImage2D needed for the run atlas (growth / reset / first upload). */
  private runFullUpload = true;
  /** runAtlas.generation at the last completed paint (mirrors lastAtlasGen). */
  private lastRunGen = 0;
  /** GL max texture dimension — caps the run-atlas width so a very wide terminal
   *  can't request a texture larger than the driver allows. */
  private maxTex = 8192;
  /** Atlas textures upload at most once per paint (not once per new glyph/run),
   *  so a screenful of fresh glyphs/runs costs one upload, not hundreds. */
  private atlasDirty = false;
  private runAtlasDirty = false;
  // Opt-in paint profiler accumulators (see paint()).
  private profN = 0;
  private profSum = 0;
  private profMax = 0;

  // Instanced pipeline: a shared unit-quad corner buffer (divisor 0) plus one
  // per-instance STREAM_DRAW buffer + VAO per draw layer.
  private quadBuf: WebGLBuffer;
  private layers: {
    bg: Layer; overlay: Layer; deco: Layer; box: Layer;
    fg: Layer; emoji: Layer; run: Layer; curBg: Layer; curFg: Layer;
  };
  private viewportLoc = new Map<WebGLProgram, WebGLUniformLocation | null>();
  private atlasLoc = new Map<WebGLProgram, WebGLUniformLocation | null>();
  /** Per-render-row cached instance lists; rebuilt only for dirty rows. */
  private rowModels: RowModel[] = [];
  /** Force a full row-model rebuild next paint (palette/metrics/dpr/atlas
   *  invalidation — anything that breaks cached colors or UVs). */
  private modelInvalid = true;
  /** atlas.generation at the last completed paint. */
  private lastAtlasGen = 0;

  constructor(
    gl: WebGL2RenderingContext,
    opts: {
      metrics: FontMetrics;
      palette?: Palette;
      atlasCanvas: HTMLCanvasElement | OffscreenCanvas;
      boldIsBright?: boolean;
      minContrast?: number;
      ligatures?: boolean;
    },
  ) {
    this.gl = gl;
    this.maxTex = (gl.getParameter(gl.MAX_TEXTURE_SIZE) as number) || 8192;
    this.metrics = opts.metrics;
    this.palette = opts.palette ?? defaultPalette;
    this.boldIsBright = opts.boldIsBright ?? false;
    this.minContrast = opts.minContrast ?? 1;
    this.ligatures = opts.ligatures ?? false;
    this.rectProg = program(gl, RECT_VS, RECT_FS);
    this.glyphProg = program(gl, GLYPH_VS, GLYPH_FS);
    this.emojiProg = program(gl, GLYPH_VS, EMOJI_FS);
    this.atlasCanvas = opts.atlasCanvas;
    this.atlasCtx = this.atlasCanvas.getContext('2d') as CanvasRenderingContext2D;
    this.atlasTex = gl.createTexture()!;
    this.runCanvas = document.createElement('canvas');
    this.runCtx = this.runCanvas.getContext('2d') as CanvasRenderingContext2D;
    this.runTex = gl.createTexture()!;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    this.quadBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    // layout(location=N) fixes attrib slots — rect color is location 2; glyph
    // uvrect=2, color=3 — so VAOs can be built without a program bound.
    const mkLayer = (kind: 'rect' | 'glyph'): Layer => {
      const list = new InstanceList(kind === 'rect' ? RECT_F : GLYPH_F, 256);
      const buf = gl.createBuffer()!;
      const vao = gl.createVertexArray()!;
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      const stride = (kind === 'rect' ? RECT_F : GLYPH_F) * 4;
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 0);
      gl.vertexAttribDivisor(1, 1);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 4 * 4);
      gl.vertexAttribDivisor(2, 1);
      if (kind === 'glyph') {
        gl.enableVertexAttribArray(3);
        gl.vertexAttribPointer(3, 4, gl.FLOAT, false, stride, 8 * 4);
        gl.vertexAttribDivisor(3, 1);
      }
      gl.bindVertexArray(null);
      return { list, buf, vao };
    };
    this.layers = {
      bg: mkLayer('rect'), overlay: mkLayer('rect'), deco: mkLayer('rect'), box: mkLayer('rect'),
      fg: mkLayer('glyph'), emoji: mkLayer('glyph'), run: mkLayer('glyph'),
      curBg: mkLayer('rect'), curFg: mkLayer('glyph'),
    };
    this.rebuildAtlas();
  }

  /** Atlas row height in device pixels (glyphs are rasterized at dpr for
   *  crisp text on retina). */
  private slotH(): number {
    return Math.ceil(this.metrics.cellHeight * this.dpr);
  }

  /** Size the atlas canvas + packer for the current metrics × dpr and drop all
   *  cached glyphs (they must re-rasterize at the new scale). Shrinks back to
   *  ATLAS_INITIAL — a 4K atlas grown for a CJK session shouldn't survive a
   *  font change. */
  private rebuildAtlas(): void {
    const side = Math.min(this.maxTex, ATLAS_INITIAL);
    this.atlasCanvas.width = side;
    this.atlasCanvas.height = side;
    this.atlas = new AtlasPacker(this.atlasCanvas.width, this.atlasCanvas.height, this.slotH() + ATLAS_PAD);
    this.atlasFullUpload = true;
    this.atlasDirtyRect = null;
    this.atlasWantsGrow = false;
    this.modelInvalid = true; // cached glyph UVs now point at dropped entries
    this.uploadAtlas();
    this.resetRunAtlas();
    this.warmAscii();
  }

  /** Double the atlas page (between paints only) preserving raster + entries. */
  private growAtlas(): void {
    const w = this.atlasCanvas.width, h = this.atlasCanvas.height;
    if (Math.max(w, h) * 2 > this.maxTex) return; // at cap — resets take over
    const tmp = document.createElement('canvas');
    tmp.width = w;
    tmp.height = h;
    tmp.getContext('2d')!.drawImage(this.atlasCanvas as HTMLCanvasElement, 0, 0);
    this.atlasCanvas.width = w * 2;
    this.atlasCanvas.height = h * 2; // resize resets ctx state; each raster sets its own
    (this.atlasCtx as CanvasRenderingContext2D).drawImage(tmp, 0, 0);
    this.atlas.grow(w * 2, h * 2);
    this.atlasFullUpload = true;
    this.atlasDirty = true;
    // Canvas dims changed → every cached UV is stale.
    this.modelInvalid = true;
  }

  /** (Re)size the run-image atlas to the current metrics × dpr and clear it. */
  private resetRunAtlas(): void {
    // Square-ish texture that holds a few hundred shaped runs; LRU-free — when it
    // fills ensureRun resets the packer (generation++ → rows rebuild).
    this.runCanvas.width = 2048;
    this.runCanvas.height = Math.max(256, 32 * (this.slotH() + ATLAS_PAD));
    // rowH includes ATLAS_PAD so a tall ligature's ascender/descender overflow
    // lands in the inter-shelf gap, not the next shelf's run (matches the glyph
    // atlas). UVs sample only the content slotH, so the pad is never read.
    this.runAtlas = new AtlasPacker(this.runCanvas.width, this.runCanvas.height, this.slotH() + ATLAS_PAD);
    this.runFullUpload = true;
    this.runDirtyRect = null;
    this.modelInvalid = true; // cached run UVs now point at cleared shelves
    this.uploadRunAtlas();
  }

  setPalette(p: Palette): void {
    this.palette = p;
    this.modelInvalid = true; // cached instance colors baked the old palette
  }

  setLigatures(on: boolean): void {
    this.ligatures = on;
    this.modelInvalid = true; // run/per-glyph split changes per row
  }

  setBoldIsBright(on: boolean): void {
    this.boldIsBright = on;
    this.modelInvalid = true; // cached fg colors baked the old mapping
  }

  setMinContrast(ratio: number): void {
    this.minContrast = ratio;
    this.modelInvalid = true; // cached fg colors baked the old contrast
  }

  setFocused(on: boolean): void {
    this.cursorFocused = on;
  }

  setDpr(dpr: number): void {
    const d = dpr || 1;
    if (d === this.dpr) return;
    this.dpr = d;
    this.rebuildAtlas(); // re-rasterize glyphs at the new device scale
  }

  setSelection(sel: SelectionRange | null): void {
    this.selection = sel;
  }

  private searchByLine: Map<number, { col: number; len: number; current: boolean }[]> | null =
    null;

  setSearchMatches(matches: SearchHighlight[] | null, current: number): void {
    this.searchMatches = matches;
    this.searchActive = current;
    if (!matches) {
      this.searchByLine = null;
      return;
    }
    // Bucket by line once here so paint() does an O(1) lookup per row instead
    // of scanning the full match list (O(rows × matches) per frame).
    const by = new Map<number, { col: number; len: number; current: boolean }[]>();
    matches.forEach((m, i) => {
      let arr = by.get(m.line);
      if (!arr) by.set(m.line, (arr = []));
      arr.push({ col: m.col, len: m.len, current: i === current });
    });
    this.searchByLine = by;
  }

  private colorOpts() {
    return { boldIsBright: this.boldIsBright, minContrast: this.minContrast };
  }

  setMetrics(metrics: FontMetrics): void {
    this.metrics = metrics;
    this.rebuildAtlas(); // slot size changed → resize + drop cached glyphs
  }

  resize(_cols: number, _rows: number, _dpr: number): void {
    // dpr is driven by setDpr (the host passes the real ratio there); the grid
    // size comes from the store at paint time. TerminalController.resize calls
    // this with dpr=1, so honoring it here would clobber the device pixel ratio
    // and shrink the viewport to a corner.
  }

  private glyphText(cell: Cell): string {
    let s = String.fromCodePoint(cell.cp);
    if (cell.zw) for (const c of cell.zw) s += String.fromCodePoint(c);
    return s;
  }

  /** Ensure a glyph is rasterized into the atlas; returns its entry origin in
   *  device px. The entry holds a white mask (color is applied per-instance in
   *  the shader), rasterized at device scale (dpr) for crisp text on retina.
   *  Used for text and the AA-needing box glyphs (rounded corners / diagonals). */
  private ensureGlyph(cell: Cell): { x: number; y: number; w: number } {
    const key = glyphKey(cell);
    const span = cell.width === 2 ? 2 : 1;
    const cw = this.contentWidth(cell, span); // device-px content width
    const hit = this.atlas.get(key);
    if (hit) return { x: hit.x, y: hit.y, w: cw };
    const w = cw + ATLAS_PAD;
    let r = this.atlas.allocate(key, w);
    if (!r) {
      // Full mid-paint: reset (generation++ → the paint loop's retry/next-frame
      // invalidation rebuilds rows) and grow before the NEXT paint. Never grow
      // mid-paint: canvas dims feed the UVs already built this frame.
      this.atlasWantsGrow = true;
      this.atlas.reset();
      const ctx = this.atlasCtx as CanvasRenderingContext2D;
      ctx.clearRect(0, 0, this.atlasCanvas.width, this.atlasCanvas.height);
      this.atlasFullUpload = true;
      // Pathological fonts (entry wider/taller than the page) still null here:
      // degrade to a (0,0) sample rather than crash.
      r = this.atlas.allocate(key, w) ?? { x: 0, y: 0, isNew: true };
    }
    this.rasterGlyph(cell, r.x, r.y, cw);
    return { x: r.x, y: r.y, w: cw };
  }

  /** Glyph content width in device px. Normal glyphs (and box glyphs) span their
   *  cell(s) exactly; a width-1 color emoji rasterizes at the fallback font's
   *  (wider) advance so it can overhang the trailing cell instead of clipping. */
  private contentWidth(cell: Cell, span: number): number {
    const cellW = Math.ceil(span * this.metrics.cellWidth * this.dpr);
    if (span !== 1 || isBoxGlyph(cell.cp) || !isEmojiCell(cell)) return cellW;
    const ctx = this.atlasCtx as CanvasRenderingContext2D;
    ctx.font = `${this.metrics.fontSize * this.dpr}px ${this.metrics.fontFamily}`;
    const m = ctx.measureText(this.glyphText(cell));
    const natural = Math.ceil(Math.max(m.width, m.actualBoundingBoxRight || 0));
    return Math.max(cellW, natural);
  }

  /** Rasterize one glyph mask at (x,y), clipped to its `contentW`-wide entry. */
  private rasterGlyph(cell: Cell, x: number, y: number, contentW: number): void {
    const ctx = this.atlasCtx as CanvasRenderingContext2D;
    const span = cell.width === 2 ? 2 : 1;
    const w = contentW;
    const h = this.slotH();
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip(); // italic overhangs must not bleed into the neighbor entry
    ctx.clearRect(x, y, w, h);
    ctx.fillStyle = '#ffffff'; // white mask; color applied per-instance
    const d = this.dpr;
    if (isBoxGlyph(cell.cp)) {
      // Draw in CSS px at the entry origin with a dpr scale transform, so
      // drawBoxGlyph's path API (rounded corners) anti-aliases and lands at
      // the same device-pixel bands as the procedural straight lines.
      ctx.setTransform(d, 0, 0, d, x, y);
      drawBoxGlyph(
        ctx,
        cell.cp,
        0,
        0,
        span * this.metrics.cellWidth,
        this.metrics.cellHeight,
        d,
        this.metrics.baseline,
        this.metrics.fontSize,
      );
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    } else {
      const bold = cell.flags & FLAG.BOLD ? 'bold ' : '';
      const italic = cell.flags & FLAG.ITALIC ? 'italic ' : '';
      ctx.font = `${italic}${bold}${this.metrics.fontSize * d}px ${this.metrics.fontFamily}`;
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(this.glyphText(cell), x, y + this.metrics.baseline * d);
    }
    ctx.restore();
    this.atlasDirty = true; // uploaded once per paint, not per glyph
    this.atlasDirtyRect = unionRect(this.atlasDirtyRect, x, y, w, h);
  }

  /** Pre-rasterize printable ASCII (normal style) so a fresh atlas doesn't
   *  hitch on the first prompt paint. One dirty rect, one upload. */
  private warmAscii(): void {
    for (let cp = 0x21; cp <= 0x7e; cp++) {
      this.ensureGlyph({ cp, fg: 0, bg: 0, flags: 0, width: 1 });
    }
  }

  private uploadAtlas(): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTex);
    if (this.atlasFullUpload || !this.atlasDirtyRect) {
      // NEAREST: glyphs are rasterized at device scale and drawn ~1:1, so no
      // interpolation is needed — and LINEAR would bleed neighboring atlas
      // entries into a glyph's edges (stray colored lines).
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.atlasCanvas as TexImageSource);
      this.atlasFullUpload = false;
    } else {
      const r = this.atlasDirtyRect;
      // Clamp to canvas bounds (raster clip can't exceed them, but be safe).
      r.x = Math.max(0, Math.min(r.x, this.atlasCanvas.width));
      r.y = Math.max(0, Math.min(r.y, this.atlasCanvas.height));
      r.w = Math.min(r.w, this.atlasCanvas.width - r.x);
      r.h = Math.min(r.h, this.atlasCanvas.height - r.y);
      if (r.w > 0 && r.h > 0) {
        // WebGL2: upload just the dirty sub-rect of the canvas.
        gl.pixelStorei(gl.UNPACK_ROW_LENGTH, this.atlasCanvas.width);
        gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, r.x);
        gl.pixelStorei(gl.UNPACK_SKIP_ROWS, r.y);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, r.x, r.y, r.w, r.h, gl.RGBA, gl.UNSIGNED_BYTE, this.atlasCanvas as TexImageSource);
        gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
        gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
        gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
      }
    }
    this.atlasDirtyRect = null;
  }

  private uploadRunAtlas(): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.runTex);
    if (this.runFullUpload || !this.runDirtyRect) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.runCanvas as TexImageSource);
      this.runFullUpload = false;
    } else {
      const r = this.runDirtyRect;
      // Clamp to canvas bounds (raster can't exceed them, but be safe).
      r.x = Math.max(0, Math.min(r.x, this.runCanvas.width));
      r.y = Math.max(0, Math.min(r.y, this.runCanvas.height));
      r.w = Math.min(r.w, this.runCanvas.width - r.x);
      r.h = Math.min(r.h, this.runCanvas.height - r.y);
      if (r.w > 0 && r.h > 0) {
        // WebGL2: upload just the dirty sub-rect of the canvas.
        gl.pixelStorei(gl.UNPACK_ROW_LENGTH, this.runCanvas.width);
        gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, r.x);
        gl.pixelStorei(gl.UNPACK_SKIP_ROWS, r.y);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, r.x, r.y, r.w, r.h, gl.RGBA, gl.UNSIGNED_BYTE, this.runCanvas as TexImageSource);
        gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
        gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
        gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
      }
    }
    this.runDirtyRect = null;
  }

  /** Rasterize a shaped run (white mask) into the run atlas; returns its device-px
   *  rect, or `null` ONLY when the run is wider than the whole atlas (the caller
   *  then draws it per-glyph so ligatures are skipped but nothing corrupts).
   *  `style` keys bold/italic (color is per-instance). When the packer fills it
   *  resets mid-paint (generation++ → the paint loop's retry/next-frame
   *  invalidation rebuilds rows, same as the glyph atlas). Marks the texture
   *  dirty; the upload is batched once per paint. */
  private ensureRun(
    text: string,
    bold: boolean,
    italic: boolean,
  ): { x: number; y: number; w: number; h: number } | null {
    const key = `${bold ? 'b' : ''}${italic ? 'i' : ''}:${text}`;
    const d = this.dpr;
    const cwDev = Math.round(this.metrics.cellWidth * d); // = cellWidth*dpr (device-aligned)
    const w = Math.max(1, text.length * cwDev);
    const h = this.slotH();
    const hit = this.runAtlas.get(key);
    if (hit) return { x: hit.x, y: hit.y, w, h }; // w/h deterministic from text+metrics
    // A run wider than the whole atlas can't be rasterized without clipping; the
    // clipped edge would then be smeared across the overflow cells by the UV
    // CLAMP_TO_EDGE (a solid bar). Bail so the caller renders it per-glyph
    // (ligatures skipped, but correct). prepareRunAtlas sizes the canvas to a
    // full line, so this only trips past the GL max texture size.
    if (w + ATLAS_PAD > this.runCanvas.width) return null;
    // Allocate ATLAS_PAD extra so the next run on this shelf starts past any
    // horizontal ink overflow (italic tail / wide glyph). UV samples only `w`.
    let r = this.runAtlas.allocate(key, w + ATLAS_PAD);
    if (!r) {
      // Full mid-paint: reset (generation++ → rows referencing old runs rebuild).
      this.runAtlas.reset();
      this.runCtx.clearRect(0, 0, this.runCanvas.width, this.runCanvas.height);
      this.runDirtyRect = null; // stale rect describes wiped pixels; null for hygiene
      this.runFullUpload = true;
      // Empty atlas: only a pathological rowH > height nulls — degrade, don't crash.
      r = this.runAtlas.allocate(key, w + ATLAS_PAD) ?? { x: 0, y: 0, isNew: true };
    }
    const ctx = this.runCtx;
    ctx.font = `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${this.metrics.fontSize * d}px ${this.metrics.fontFamily}`;
    ctx.textBaseline = 'alphabetic';
    // Rasterize the run so every glyph already sits on the device CELL grid, then
    // draw the image 1:1 (the run quad maps it onto the same n-cell span). cellWidth
    // is the font advance ROUNDED to a whole device px (metrics.cellWidthFor), so
    // cellWidth*dpr is integer; the font's NATURAL advance is unrounded. Nudge
    // every glyph by that delta via letterSpacing so glyph k lands at k*cellWidth.
    // The image is then exactly text.length*cellWidth*dpr wide — equal to its grid
    // span — so the quad scale is EXACTLY 1: no NEAREST stretch (the "merged
    // letters" squeeze + the smeared horizontal lines on a tiny-measured run) and
    // no cross-line drift (each cell is re-anchored, not accumulating advance
    // error). Ligature advances are whole multiples of the cell advance in a
    // monospace font, so ligatures stay on grid too. measureText('M') must be read
    // WITHOUT spacing, so reset it first; reset again after so the next raster's
    // measure isn't skewed.
    ctx.letterSpacing = '0px';
    const adv = ctx.measureText('M').width; // natural monospace advance (device px)
    ctx.letterSpacing = `${cwDev - adv}px`;
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x, r.y, w, h);
    ctx.clip(); // confine ascender/descender/overhang to this slot (no shelf bleed)
    ctx.clearRect(r.x, r.y, w, h);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(text, r.x, r.y + this.metrics.baseline * d);
    ctx.restore();
    ctx.letterSpacing = '0px'; // reset so the next run's measureText('M') is clean
    this.runAtlasDirty = true; // uploaded once per paint, not per run
    this.runDirtyRect = unionRect(this.runDirtyRect, r.x, r.y, w, h);
    return { x: r.x, y: r.y, w, h };
  }

  /** Grow the run atlas (between paints only) to comfortably hold a screenful
   *  of distinct full-width runs. Canvas resize wipes the raster, so growth
   *  behaves like reset+resize (packer reset + full upload). Reset-on-full
   *  lives in ensureRun. Returns true when the cache was cleared (every cached
   *  row's run UVs are stale → full row rebuild). */
  private prepareRunAtlas(rows: number, cols: number): boolean {
    const h = this.slotH() + ATLAS_PAD; // padded shelf height (see resetRunAtlas)
    // A single run can span a whole line (cols cells); size the width to hold it
    // so a wide line's run isn't clipped at a fixed width and then smeared into a
    // solid bar by CLAMP_TO_EDGE when its UVs run past 1.0. Match ensureRun's
    // per-cell device width exactly. Clamp to the GL max texture size.
    const cwDev = Math.round(this.metrics.cellWidth * this.dpr);
    // +ATLAS_PAD so a full-width run (cols*cwDev) still fits with its trailing
    // pad and isn't demoted to per-glyph fallback by ensureRun's width guard.
    const wantW = Math.min(this.maxTex, Math.max(2048, cols * cwDev + ATLAS_PAD));
    // Room for a full screen of single-run rows + headroom for multi-run rows
    // (color/style splits add shelves); GL max-texture clamps the extreme.
    const wantH = Math.min(this.maxTex, 8192, (rows * 2 + 8) * h);
    const w = Math.max(this.runCanvas.width, wantW);
    const h2 = Math.max(this.runCanvas.height, wantH);
    if (w > this.runCanvas.width || h2 > this.runCanvas.height) {
      this.runCanvas.width = w;
      this.runCanvas.height = h2; // setting size also clears the canvas
      // Recreate the packer with the exact new canvas dims so it never believes
      // the old larger extent (grow is Math.max; reset keeps dims). Raster is
      // wiped by the resize so a full rebuild is already forced below.
      this.runAtlas = new AtlasPacker(w, h2, this.slotH() + ATLAS_PAD);
      this.runFullUpload = true;
      this.runDirtyRect = null;
      this.runAtlasDirty = true;
      return true;
    }
    return false;
  }

  /** Build context for buildRow — constructed once per paint (only `y` varies
   *  per row; the caller mutates it). Atlas access is injected so the model
   *  layer stays GL/DOM-free. */
  private buildCtxFor(y: number, cols: number): RowBuildCtx {
    return {
      y, cols,
      metrics: this.metrics,
      dpr: this.dpr,
      palette: this.palette,
      colorOpts: this.colorOpts(),
      ligatures: this.ligatures,
      atlasW: this.atlasCanvas.width,
      atlasH: this.atlasCanvas.height,
      runAtlasW: this.runCanvas.width,
      runAtlasH: this.runCanvas.height,
      ensureGlyph: (cell) => this.ensureGlyph(cell),
      ensureRun: (text, bold, italic) => this.ensureRun(text, bold, italic),
      isEmoji: isEmojiCell,
    };
  }

  /** Upload a layer's packed instances and draw them as instanced unit quads. */
  private drawLayer(l: Layer, prog: WebGLProgram, vw: number, vh: number, tex?: WebGLTexture): void {
    if (l.list.count === 0) return;
    const gl = this.gl;
    gl.useProgram(prog);
    let vp = this.viewportLoc.get(prog);
    if (vp === undefined) {
      vp = gl.getUniformLocation(prog, 'u_viewport');
      this.viewportLoc.set(prog, vp);
    }
    gl.uniform2f(vp, vw, vh);
    if (tex) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      let al = this.atlasLoc.get(prog);
      if (al === undefined) {
        al = gl.getUniformLocation(prog, 'u_atlas');
        this.atlasLoc.set(prog, al);
      }
      gl.uniform1i(al, 0);
    }
    gl.bindVertexArray(l.vao);
    // ARRAY_BUFFER binding is not VAO state — bind for the upload; the VAO's
    // attrib pointers already reference l.buf.
    gl.bindBuffer(gl.ARRAY_BUFFER, l.buf);
    gl.bufferData(gl.ARRAY_BUFFER, l.list.view(), gl.STREAM_DRAW);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, l.list.count);
    gl.bindVertexArray(null);
  }

  /** Repaint the whole visible screen (bounded by the viewport). Layered like
   *  Canvas2D: backgrounds → selection/search → decorations → glyphs → cursor
   *  (so the cursor's bars sit over glyphs and a focused block re-draws the
   *  glyph). Damage-driven: each render row's instance lists are cached and
   *  only dirty rows rebuild; overlays/cursor repack every paint. */
  paint(store: GridStore): void {
    // Opt-in profiling: set `__VERNE_TERM_PROFILE = true` in devtools to log
    // avg/max paint time per 60 frames. Zero cost when off. Use this to verify
    // the damage-driven path holds under load.
    const t0 = (globalThis as unknown as { __VERNE_TERM_PROFILE?: boolean }).__VERNE_TERM_PROFILE
      ? performance.now()
      : 0;
    const gl = this.gl;
    // Hidden/zero-sized canvas (background tab, collapsed split, pre-layout
    // mount): the default framebuffer is 0×0, so clear/draw would log
    // GL_INVALID_FRAMEBUFFER_OPERATION. Nothing to draw — skip; applySize +
    // markAllDirty repaints fully on becoming visible.
    if (gl.drawingBufferWidth === 0 || gl.drawingBufferHeight === 0) return;
    const { cellWidth, cellHeight } = this.metrics;
    const vw = store.cols * cellWidth;
    const vh = store.rows * cellHeight;
    // Grow atlases BETWEEN frames only (canvas dims feed the UVs built this
    // frame) — must precede the rebuild loop so growth forces the rebuild
    // instead of stranding cached UVs.
    if (this.atlasWantsGrow) {
      this.atlasWantsGrow = false;
      this.growAtlas(); // between paints: full upload + modelInvalid
    }
    const runAtlasReset = this.prepareRunAtlas(store.rows, store.cols);
    if (this.rowModels.length !== store.rows) {
      this.rowModels = Array.from({ length: store.rows }, () => makeRowModel());
      this.modelInvalid = true;
    }
    if (this.atlas.generation !== this.lastAtlasGen) this.modelInvalid = true;
    if (this.runAtlas.generation !== this.lastRunGen) this.modelInvalid = true;
    const rebuildAll = this.modelInvalid || runAtlasReset;

    // One build ctx per paint; only y varies per row.
    const buildCtx = this.buildCtxFor(0, store.cols);
    for (let row = 0; row < store.rows; row++) {
      if (!rebuildAll && !store.dirtyRows.has(row)) continue;
      buildCtx.y = row * cellHeight;
      buildRow(store.visibleRow(row), buildCtx, this.rowModels[row]);
    }
    // Rebuilding can itself reset the atlas (working set > capacity): cached
    // CLEAN rows may now reference stale entries. One retry pass fixes the
    // steady-state case; a working set that exceeds capacity every frame
    // degrades to full rebuilds (= the old behavior, not corruption) until
    // the deferred growth catches up.
    if (
      this.atlas.generation !== this.lastAtlasGen ||
      this.runAtlas.generation !== this.lastRunGen
    ) {
      for (let row = 0; row < store.rows; row++) {
        buildCtx.y = row * cellHeight;
        buildRow(store.visibleRow(row), buildCtx, this.rowModels[row]);
      }
    }
    this.lastAtlasGen = this.atlas.generation;
    this.lastRunGen = this.runAtlas.generation;
    this.modelInvalid = false;

    const L = this.layers;
    L.bg.list.reset(); L.overlay.list.reset(); L.deco.list.reset(); L.box.list.reset();
    L.fg.list.reset(); L.emoji.list.reset(); L.run.list.reset();
    L.curBg.list.reset(); L.curFg.list.reset();

    // Snap a CSS coordinate to the device-pixel grid so adjacent cells abut
    // exactly (block glyphs tile seamlessly; backgrounds leave no seams).
    const snap = (v: number) => Math.round(v * this.dpr) / this.dpr;
    const rect = (l: InstanceList, x: number, y: number, w: number, h: number, c: Rgba) => {
      const x0 = snap(x), y0 = snap(y);
      l.pushRect(x0, y0, snap(x + w) - x0, snap(y + h) - y0, c);
    };

    const selRange = this.selection;
    for (let row = 0; row < store.rows; row++) {
      const cells = store.visibleRow(row);
      const y = row * cellHeight;
      const rm = this.rowModels[row];
      L.bg.list.append(rm.bg);
      L.deco.list.append(rm.deco);
      L.box.list.append(rm.box);
      L.fg.list.append(rm.fg);
      L.emoji.list.append(rm.emoji);
      L.run.list.append(rm.run);

      // Overlays (selection, then search) — one layer drawn after bg, under
      // decorations/glyphs, matching the old shared selection/search buffer.
      const absLine = store.absLineAt(row);
      if (selRange && absLine >= selRange.startLine && absLine <= selRange.endLine) {
        const c0 = absLine === selRange.startLine ? selRange.startCol : 0;
        const c1 = absLine === selRange.endLine ? selRange.endCol : cells.length;
        if (c1 > c0) {
          rect(L.overlay.list, c0 * cellWidth, y, (c1 - c0) * cellWidth, cellHeight, cssToRgba(this.palette.selection));
        }
      }
      const sm = this.searchByLine?.get(absLine);
      if (sm) {
        for (const m of sm) {
          const css = m.current ? this.palette.searchMatchCurrent : this.palette.searchMatch;
          rect(L.overlay.list, m.col * cellWidth, y, m.len * cellWidth, cellHeight, cssToRgba(css));
        }
      }
    }

    // Cursor — pushCursor tracks the scroll offset and bails when its line has
    // scrolled off-screen, so it stays glued to its line while scrolling.
    if (this.cursorVisible) {
      this.pushCursor(store);
    }

    // Upload each atlas at most once, after ALL ensureGlyph/ensureRun for this
    // frame (incl. the block-cursor glyph above) — not once per new glyph/run.
    if (this.atlasDirty) {
      this.uploadAtlas();
      this.atlasDirty = false;
    }
    if (this.runAtlasDirty) {
      this.uploadRunAtlas();
      this.runAtlasDirty = false;
    }

    gl.viewport(0, 0, vw * this.dpr, vh * this.dpr);
    gl.clearColor(...cssToRgba(this.palette.background));
    gl.clear(gl.COLOR_BUFFER_BIT);

    this.drawLayer(L.bg, this.rectProg, vw, vh);
    this.drawLayer(L.overlay, this.rectProg, vw, vh);
    this.drawLayer(L.deco, this.rectProg, vw, vh);
    this.drawLayer(L.box, this.rectProg, vw, vh);
    this.drawLayer(L.fg, this.glyphProg, vw, vh, this.atlasTex);
    this.drawLayer(L.emoji, this.emojiProg, vw, vh, this.atlasTex); // color glyphs, untinted
    this.drawLayer(L.run, this.glyphProg, vw, vh, this.runTex);
    this.drawLayer(L.curBg, this.rectProg, vw, vh);
    this.drawLayer(L.curFg, this.glyphProg, vw, vh, this.atlasTex);
    store.clearDirty();

    if (t0) {
      const dt = performance.now() - t0;
      this.profSum += dt;
      this.profMax = Math.max(this.profMax, dt);
      if (++this.profN >= 60) {
        // eslint-disable-next-line no-console
        console.log(
          `[term paint] avg ${(this.profSum / this.profN).toFixed(2)}ms max ${this.profMax.toFixed(2)}ms over ${this.profN} frames (${store.cols}x${store.rows})`,
        );
        this.profN = 0;
        this.profSum = 0;
        this.profMax = 0;
      }
    }
  }

  /** Draw the cursor in its active shape. Mirrors Canvas2DRenderer.paintCursor:
   *  unfocused/hollow → outline; beam/underline → bar; block → fill + glyph in
   *  the background color. */
  private pushCursor(store: GridStore): void {
    const shape = store.cursorShape;
    if (shape === 'hidden') return;
    const ccol = store.cursor[1];
    const renderRow = store.cursorRow();
    if (renderRow < 0 || renderRow >= store.rows) return;
    const { cellWidth, cellHeight } = this.metrics;
    const cells = store.visibleRow(renderRow);
    const under = cells[ccol];
    const cw = (under?.width === 2 ? 2 : 1) * cellWidth;
    const cx = ccol * cellWidth;
    const y = renderRow * cellHeight;
    const t = Math.max(1, Math.round(cellWidth / 6));
    const cur = cssToRgba(this.palette.cursor);
    const snap = (v: number) => Math.round(v * this.dpr) / this.dpr;
    const bg = this.layers.curBg.list;
    const rect = (x: number, yy: number, w: number, h: number, c: Rgba) => {
      const x0 = snap(x), y0 = snap(yy);
      bg.pushRect(x0, y0, snap(x + w) - x0, snap(yy + h) - y0, c);
    };

    if (!this.cursorFocused || shape === 'hollow') {
      rect(cx, y, cw, t, cur);
      rect(cx, y + cellHeight - t, cw, t, cur);
      rect(cx, y, t, cellHeight, cur);
      rect(cx + cw - t, y, t, cellHeight, cur);
      return;
    }
    if (shape === 'beam') {
      rect(cx, y, t, cellHeight, cur);
      return;
    }
    if (shape === 'underline') {
      rect(cx, y + cellHeight - t, cw, t, cur);
      return;
    }
    // Block: fill the cell, then re-draw the glyph beneath in the bg color.
    rect(cx, y, cw, cellHeight, cur);
    if (under && under.cp !== 32 && under.cp !== 0 && !(under.flags & FLAG.HIDDEN)) {
      const span = under.width === 2 ? 2 : 1;
      const r = this.ensureGlyph(under);
      const aw = this.atlasCanvas.width;
      const ah = this.atlasCanvas.height;
      const overhang = span === 1 && isEmojiCell(under);
      const inkW = overhang ? r.w : span * cellWidth * this.dpr;
      const inkH = cellHeight * this.dpr;
      const x0 = snap(cx), y0 = snap(y);
      this.layers.curFg.list.pushGlyph(
        x0, y0, snap(cx + inkW / this.dpr) - x0, snap(y + cellHeight) - y0,
        r.x / aw, r.y / ah, (r.x + inkW) / aw, (r.y + inkH) / ah,
        cssToRgba(this.palette.background),
      );
    }
  }

  /** TEST-ONLY: run-atlas backing canvas + padded shelf height, for bleed probes. */
  __debugRunCanvas(): { canvas: HTMLCanvasElement; rowH: number; slotH: number } {
    return { canvas: this.runCanvas as HTMLCanvasElement, rowH: this.slotH() + ATLAS_PAD, slotH: this.slotH() };
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteBuffer(this.quadBuf);
    for (const l of Object.values(this.layers)) {
      gl.deleteBuffer(l.buf);
      gl.deleteVertexArray(l.vao);
    }
    gl.deleteTexture(this.atlasTex);
    gl.deleteTexture(this.runTex);
    gl.deleteProgram(this.rectProg);
    gl.deleteProgram(this.glyphProg);
    gl.deleteProgram(this.emojiProg);
  }
}
