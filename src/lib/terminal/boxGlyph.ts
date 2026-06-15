// Procedural box-drawing + block-element glyphs. Drawing these from the font
// leaves gaps when the line height exceeds the glyph height (vertical bars stop
// short of the cell edge, so adjacent rows don't connect). Draw them to fill
// the cell exactly so they always join. Uses only
// fillRect/fillStyle so it works through the renderer's minimal 2D interface.

interface RectCtx {
  fillStyle: string | CanvasGradient | CanvasPattern;
  globalAlpha?: number;
  fillRect(x: number, y: number, w: number, h: number): void;
  // Optional path API (present on a real canvas) used for rounded corners; when
  // absent (test fakes) rounded corners fall back to sharp.
  strokeStyle?: string | CanvasGradient | CanvasPattern;
  lineWidth?: number;
  lineCap?: CanvasLineCap;
  beginPath?(): void;
  moveTo?(x: number, y: number): void;
  lineTo?(x: number, y: number): void;
  arcTo?(x1: number, y1: number, x2: number, y2: number, radius: number): void;
  stroke?(): void;
}

// Edges per line char: [up, down, left, right], 0 none / 1 light / 2 heavy /
// 3 double. Rounded corners are drawn as sharp — they still connect cleanly.
const E: Record<number, [number, number, number, number]> = {
  0x2500: [0, 0, 1, 1], // ─
  0x2501: [0, 0, 2, 2], // ━
  0x2502: [1, 1, 0, 0], // │
  0x2503: [2, 2, 0, 0], // ┃
  0x250c: [0, 1, 0, 1], // ┌
  0x250f: [0, 2, 0, 2], // ┏
  0x2510: [0, 1, 1, 0], // ┐
  0x2513: [0, 2, 2, 0], // ┓
  0x2514: [1, 0, 0, 1], // └
  0x2517: [2, 0, 0, 2], // ┗
  0x2518: [1, 0, 1, 0], // ┘
  0x251b: [2, 0, 2, 0], // ┛
  0x251c: [1, 1, 0, 1], // ├
  0x2523: [2, 2, 0, 2], // ┣
  0x2524: [1, 1, 1, 0], // ┤
  0x252b: [2, 2, 2, 0], // ┫
  0x252c: [0, 1, 1, 1], // ┬
  0x2533: [0, 2, 2, 2], // ┳
  0x2534: [1, 0, 1, 1], // ┴
  0x253b: [2, 0, 2, 2], // ┻
  0x253c: [1, 1, 1, 1], // ┼
  0x254b: [2, 2, 2, 2], // ╋
  0x256d: [0, 1, 0, 1], // ╭
  0x256e: [0, 1, 1, 0], // ╮
  0x256f: [1, 0, 1, 0], // ╯
  0x2570: [1, 0, 0, 1], // ╰
  0x2574: [0, 0, 1, 0], // ╴
  0x2575: [1, 0, 0, 0], // ╵
  0x2576: [0, 0, 0, 1], // ╶
  0x2577: [0, 1, 0, 0], // ╷
  // Double-line box drawing (U+2550-256C): 3 = double.
  0x2550: [0, 0, 3, 3], // ═
  0x2551: [3, 3, 0, 0], // ║
  0x2552: [0, 1, 0, 3], // ╒
  0x2553: [0, 3, 0, 1], // ╓
  0x2554: [0, 3, 0, 3], // ╔
  0x2555: [0, 1, 3, 0], // ╕
  0x2556: [0, 3, 1, 0], // ╖
  0x2557: [0, 3, 3, 0], // ╗
  0x2558: [1, 0, 0, 3], // ╘
  0x2559: [3, 0, 0, 1], // ╙
  0x255a: [3, 0, 0, 3], // ╚
  0x255b: [1, 0, 3, 0], // ╛
  0x255c: [3, 0, 1, 0], // ╜
  0x255d: [3, 0, 3, 0], // ╝
  0x255e: [1, 1, 0, 3], // ╞
  0x255f: [3, 3, 0, 1], // ╟
  0x2560: [3, 3, 0, 3], // ╠
  0x2561: [1, 1, 3, 0], // ╡
  0x2562: [3, 3, 1, 0], // ╢
  0x2563: [3, 3, 3, 0], // ╣
  0x2564: [0, 1, 3, 3], // ╤
  0x2565: [0, 3, 1, 1], // ╥
  0x2566: [0, 3, 3, 3], // ╦
  0x2567: [1, 0, 3, 3], // ╧
  0x2568: [3, 0, 1, 1], // ╨
  0x2569: [3, 0, 3, 3], // ╩
  0x256a: [1, 1, 3, 3], // ╪
  0x256b: [3, 3, 1, 1], // ╫
  0x256c: [3, 3, 3, 3], // ╬
};

// Geometric squares (filled/outline) used as agent todo markers (◻ pending / ◼
// in-progress). Value = [filled, side-as-fraction-of-the-text-cap-band]. Drawn
// sized to the text cap height and sat on the baseline (see drawSquare) — NOT the
// cell box — so they read as a checkbox beside the glyphs, not a tiny low dot.
const SQUARES: Record<number, [boolean, number]> = {
  0x25a0: [true, 1.0], // ■ black square (full)
  0x25a1: [false, 1.0], // □ white square (full)
  0x25aa: [true, 0.55], // ▪ black small square
  0x25ab: [false, 0.55], // ▫ white small square
  0x25fb: [false, 0.95], // ◻ white medium square (pending todo)
  0x25fc: [true, 0.95], // ◼ black medium square (in-progress todo)
  0x25fd: [false, 0.75], // ◽ white medium small square
  0x25fe: [true, 0.75], // ◾ black medium small square
};

/** True for code points this module renders procedurally. */
export function isBoxGlyph(cp: number): boolean {
  if (cp in E) return true;
  if (cp >= 0x2504 && cp <= 0x250b) return true; // dashed/dotted box lines
  if (cp >= 0x2571 && cp <= 0x2573) return true; // diagonals ╱ ╲ ╳
  if (cp >= 0x2580 && cp <= 0x259f) return true; // block elements + quadrants
  if (cp === 0x23bf) return true; // ⎿ tree connector (agent task lists)
  if (cp in SQUARES) return true; // ■□▪▫◻◼◽◾ geometric squares (agent todo markers)
  if (cp >= 0xe0b0 && cp <= 0xe0b7) return true; // Powerline separators
  if (cp >= 0x1fb00 && cp <= 0x1fb3b) return true; // Legacy Computing sextants
  return false;
}

/** Draw the box/block glyph for `cp` filling the cell at (x,y,w,h). The caller
 *  sets `ctx.fillStyle` (and globalAlpha) to the cell foreground first. Returns
 *  false if `cp` isn't a procedural glyph (caller should fall back to the font). */
export function drawBoxGlyph(
  ctx: RectCtx,
  cp: number,
  x: number,
  y: number,
  w: number,
  h: number,
  dpr = 1,
  // Text metrics (CSS px) for glyphs that read as symbols beside the text rather
  // than tiling lines — squares + the ⎿ tree connector align to the text band
  // (cell top → baseline) instead of the full cell box, which dips below the
  // baseline into descender/leading space. Omitted by test fakes → cell-box
  // fallback (the old behaviour).
  baseline?: number,
  fontSize?: number,
): boolean {
  // Rounded corners get a real arc when the canvas path API is available.
  if (cp >= 0x256d && cp <= 0x2570 && ctx.beginPath && ctx.arcTo && ctx.stroke && ctx.moveTo) {
    drawRoundedCorner(ctx, cp, x, y, w, h, dpr);
    return true;
  }
  if (cp >= 0x2504 && cp <= 0x250b) {
    drawDashed(ctx, cp, x, y, w, h, dpr);
    return true;
  }
  if (cp >= 0x2571 && cp <= 0x2573) {
    drawDiagonal(ctx, cp, x, y, w, h, dpr);
    return true;
  }
  if (cp === 0x23bf) {
    drawTreeConnector(ctx, x, y, w, h, dpr, baseline);
    return true;
  }
  const sq = SQUARES[cp];
  if (sq) {
    drawSquare(ctx, sq[0], sq[1], x, y, w, h, dpr, baseline, fontSize);
    return true;
  }
  const edges = E[cp];
  if (edges) {
    drawLines(ctx, edges, x, y, w, h, dpr);
    return true;
  }
  if (cp >= 0x2580 && cp <= 0x259f) {
    drawBlock(ctx, cp, x, y, w, h, dpr);
    return true;
  }
  if (cp >= 0xe0b0 && cp <= 0xe0b7) {
    drawPowerline(ctx, cp, x, y, w, h);
    return true;
  }
  if (cp >= 0x1fb00 && cp <= 0x1fb3b) {
    drawSextant(ctx, cp, x, y, w, h);
    return true;
  }
  return false;
}

/** Powerline separators (U+E0B0-E0B7): solid/outline triangles + half-circles.
 *  Drawn as per-row horizontal slices so only fillRect is needed and they fill
 *  edge-to-edge (connecting with the adjacent cell's background). */
function drawPowerline(ctx: RectCtx, cp: number, x: number, y: number, w: number, h: number): void {
  const t = Math.max(1, Math.round(w / 8));
  // shape of the right edge as a fraction of width, per vertical position d∈[0,1]
  // from the center (0 = center, 1 = top/bottom edge).
  const isCircle = cp >= 0xe0b4;
  const frac = (d: number) => (isCircle ? Math.sqrt(Math.max(0, 1 - d * d)) : 1 - d);
  // E0B0/E0B4 point/bulge right (flat left); E0B2/E0B6 mirror. Odd codes are
  // the outline (chevron / arc) variants.
  const left = cp === 0xe0b2 || cp === 0xe0b3 || cp === 0xe0b6 || cp === 0xe0b7;
  const outline = cp === 0xe0b1 || cp === 0xe0b3 || cp === 0xe0b5 || cp === 0xe0b7;
  for (let yy = 0; yy < h; yy++) {
    const d = Math.abs(yy + 0.5 - h / 2) / (h / 2);
    const fw = w * frac(d);
    if (fw <= 0) continue;
    if (outline) {
      const edge = left ? w - fw : fw - t;
      ctx.fillRect(Math.round(x + edge), y + yy, t, 1);
    } else if (left) {
      ctx.fillRect(Math.round(x + w - fw), y + yy, Math.ceil(fw), 1);
    } else {
      ctx.fillRect(x, y + yy, Math.ceil(fw), 1);
    }
  }
}

// Sextant code points (U+1FB00-1FB3B) cover the 2×3 sub-cell patterns except
// the four already encoded as blocks: empty(0), left-half(0b010101=21),
// right-half(0b101010=42), full(63). Bits: 0=top-left,1=top-right,2=mid-left,
// 3=mid-right,4=bottom-left,5=bottom-right.
const SEXTANT_PATTERNS: number[] = (() => {
  const out: number[] = [];
  for (let n = 1; n <= 62; n++) {
    if (n === 21 || n === 42) continue;
    out.push(n);
  }
  return out; // 60 entries → indices 0..59 == U+1FB00..1FB3B
})();

function drawSextant(ctx: RectCtx, cp: number, x: number, y: number, w: number, h: number): void {
  const bits = SEXTANT_PATTERNS[cp - 0x1fb00];
  if (bits === undefined) return;
  const mx = Math.round(w / 2);
  const r1 = Math.round(h / 3);
  const r2 = Math.round((2 * h) / 3);
  const colX = [0, mx, w];
  const rowY = [0, r1, r2, h];
  for (let i = 0; i < 6; i++) {
    if (!(bits & (1 << i))) continue;
    const c = i % 2; // 0 left, 1 right
    const r = Math.floor(i / 2); // 0..2
    ctx.fillRect(x + colX[c], y + rowY[r], colX[c + 1] - colX[c], rowY[r + 1] - rowY[r]);
  }
}

/** Cap-height as a fraction of the em (fontSize). Most monospace faces sit around
 *  0.7–0.75; we want the marker to read as tall as the surrounding capitals. */
const CAP_FRAC = 0.74;

/** Filled or outline square (■□▪▫◻◼◽◾). `frac` is the side as a fraction of the
 *  text cap band. Sized to the cap height and sat on the baseline (when metrics
 *  are given) so it reads as a checkbox beside the glyphs — sizing to
 *  min(w,h)=cell width + centering in the full line box made it ~half the cap
 *  height and dropped it into the sub-baseline gap (a tiny low dot). Width is
 *  clamped to the cell so a cap-height box can't bleed into the next cell.
 *  Falls back to inset+centered in the cell box when metrics are absent (test
 *  fakes). fillRect only — the outline never clips at the cell edge. */
function drawSquare(
  ctx: RectCtx,
  filled: boolean,
  frac: number,
  x: number,
  y: number,
  w: number,
  h: number,
  dpr: number,
  baseline?: number,
  fontSize?: number,
): void {
  // Snap every edge to the device-pixel grid so the square is crisp + symmetric.
  const S = (v: number) => Math.round(v * dpr) / dpr;
  const capH = fontSize !== undefined ? fontSize * CAP_FRAC : Math.min(w, h);
  // Square sized to the cap band, but never wider than (most of) the cell so it
  // can't bleed into the neighbour. Cap height usually exceeds the cell width, so
  // the full/medium markers land at ~cell width; the small ▪▫ stay cap-relative.
  const side = Math.min(capH * frac, w * 0.92);
  const cx = x + w / 2;
  // Center on the cap band (baseline up to the cap top); fall back to the cell
  // center when no baseline is supplied.
  const cy = baseline !== undefined ? y + baseline - capH / 2 : y + h / 2;
  const x0 = S(cx - side / 2);
  const y0 = S(cy - side / 2);
  const x1 = S(cx + side / 2);
  const y1 = S(cy + side / 2);
  if (filled) {
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    return;
  }
  const t = lightThicknessDev(w, h, dpr) / dpr; // stroke (CSS px)
  ctx.fillRect(x0, y0, x1 - x0, t); // top
  ctx.fillRect(x0, y1 - t, x1 - x0, t); // bottom
  ctx.fillRect(x0, y0, t, y1 - y0); // left
  ctx.fillRect(x1 - t, y0, t, y1 - y0); // right
}

/** ⎿ (U+23BF) tree connector: a vertical stroke down to a horizontal foot going
 *  right — the branch Claude/Codex draw before a task-list result. The font
 *  glyph's foot is a thin hairline that clips at the cell edge (the original
 *  bug); drawing it fills the cell so the horizontal survives. The corner sits at
 *  the text BASELINE, not the cell bottom: the cell runs below the baseline
 *  (descender + line leading), so a foot at the cell bottom floats in that empty
 *  gap, detached and too low under the text (the second bug). Falls back to the
 *  cell bottom when no baseline is supplied (test fakes). */
function drawTreeConnector(
  ctx: RectCtx,
  x: number,
  y: number,
  w: number,
  h: number,
  dpr: number,
  baseline?: number,
): void {
  const D = (v: number) => Math.round(v * dpr);
  const t = lightThicknessDev(w, h, dpr); // device px
  const cx = D(x + w / 2);
  const a = cx - (t >> 1); // left edge of the vertical rail (device px)
  const Y0 = D(y);
  const Yb = baseline !== undefined ? D(y + baseline) : D(y + h); // baseline (or cell bottom)
  const X1 = D(x + w);
  const rect = (dx0: number, dy0: number, dx1: number, dy1: number) =>
    ctx.fillRect(dx0 / dpr, dy0 / dpr, (dx1 - dx0) / dpr, (dy1 - dy0) / dpr);
  rect(a, Y0, a + t, Yb); // vertical: cell top → baseline (connects up to a parent │)
  rect(a, Yb - t, X1, Yb); // horizontal foot: corner → right edge, at the baseline
}

/** Light-line stroke thickness in DEVICE pixels. Floored at one CSS pixel
 *  (= `dpr` device px) so lines never render as a faint sub-CSS-pixel hairline
 *  on Retina — a 1-device-px line on a 2× display reads as washed-out/uncertain,
 *  especially for the AA'd rounded corners. Scales up for large fonts. */
function lightThicknessDev(w: number, h: number, dpr: number): number {
  return Math.max(Math.round(dpr), Math.round((Math.min(w, h) * dpr) / 12));
}

function drawLines(
  ctx: RectCtx,
  [up, down, left, right]: [number, number, number, number],
  x: number,
  y: number,
  w: number,
  h: number,
  dpr: number,
): void {
  // Work in integer device pixels so strokes are crisp hairlines and cell
  // boundaries align exactly across neighbours (no gaps).
  const D = (v: number) => Math.round(v * dpr);
  const lightT = lightThicknessDev(w, h, dpr);
  const heavyT = lightT * 2;
  const g = lightT + Math.max(1, Math.round(dpr)); // double-rail offset (device px)
  const cx = D(x + w / 2);
  const cy = D(y + h / 2);
  const X0 = D(x);
  const Y0 = D(y);
  const X1 = D(x + w);
  const Y1 = D(y + h);
  const vWeight = Math.max(up, down);
  const hWeight = Math.max(left, right);
  const vt = vWeight === 2 ? heavyT : lightT;
  const ht = hWeight === 2 ? heavyT : lightT;
  const vRails = vWeight === 3 ? [cx - g, cx + g] : [cx];
  const hRails = hWeight === 3 ? [cy - g, cy + g] : [cy];
  const vReach = (hWeight === 3 ? g : 0) + Math.ceil(ht / 2);
  const hReach = (vWeight === 3 ? g : 0) + Math.ceil(vt / 2);
  // device-px rect → CSS fillRect (ctx transform scales by dpr).
  const rect = (dx0: number, dy0: number, dx1: number, dy1: number) =>
    ctx.fillRect(dx0 / dpr, dy0 / dpr, (dx1 - dx0) / dpr, (dy1 - dy0) / dpr);
  const lo = (center: number, t: number) => center - (t >> 1);
  for (const rxC of vRails) {
    const a = lo(rxC, vt);
    if (up) rect(a, Y0, a + vt, cy + vReach);
    if (down) rect(a, cy - vReach, a + vt, Y1);
  }
  for (const ryC of hRails) {
    const a = lo(ryC, ht);
    if (left) rect(X0, a, cx + hReach, a + ht);
    if (right) rect(cx - hReach, a, X1, a + ht);
  }
}

/** Dashed/dotted box lines U+2504-250B (2504-2507 triple, 2508-250B quadruple;
 *  even = horizontal, odd... actually 2504/2505 h, 2506/2507 v, etc.). Drawn as
 *  evenly-spaced dash segments along the center line. */
function drawDashed(
  ctx: RectCtx,
  cp: number,
  x: number,
  y: number,
  w: number,
  h: number,
  dpr: number,
): void {
  const light = lightThicknessDev(w, h, dpr) / dpr; // hairline (CSS px)
  const heavy = light * 2;
  const t = cp % 2 === 1 ? heavy : light; // odd code points are the heavy variant
  const dashes = cp <= 0x2507 ? 3 : 4;
  const horizontal = cp === 0x2504 || cp === 0x2505 || cp === 0x2508 || cp === 0x2509;
  const cx = x + w / 2;
  const cy = y + h / 2;
  for (let i = 0; i < dashes; i++) {
    if (horizontal) {
      const slot = w / dashes;
      const x0 = x + i * slot + slot * 0.15;
      const len = slot * 0.7;
      ctx.fillRect(Math.floor(x0), Math.round(cy - t / 2), Math.ceil(len), t);
    } else {
      const slot = h / dashes;
      const y0 = y + i * slot + slot * 0.15;
      const len = slot * 0.7;
      ctx.fillRect(Math.round(cx - t / 2), Math.floor(y0), t, Math.ceil(len));
    }
  }
}

/** Diagonals ╱ (2571) ╲ (2572) ╳ (2573). Stroked corner-to-corner when the path
 *  API is available; otherwise approximated with a per-column staircase. */
function drawDiagonal(
  ctx: RectCtx,
  cp: number,
  x: number,
  y: number,
  w: number,
  h: number,
  dpr: number,
): void {
  const t = lightThicknessDev(w, h, dpr) / dpr; // hairline (CSS px)
  const fwd = cp === 0x2571 || cp === 0x2573; // ╱ or ╳
  const back = cp === 0x2572 || cp === 0x2573; // ╲ or ╳
  if (ctx.beginPath && ctx.moveTo && ctx.lineTo && ctx.stroke) {
    ctx.lineWidth = t;
    ctx.lineCap = 'butt';
    ctx.strokeStyle = ctx.fillStyle;
    ctx.beginPath();
    if (fwd) {
      ctx.moveTo(x, y + h);
      ctx.lineTo(x + w, y);
    }
    if (back) {
      ctx.moveTo(x, y);
      ctx.lineTo(x + w, y + h);
    }
    ctx.stroke();
    return;
  }
  // Fallback: staircase of dots along the diagonal(s).
  const td = Math.max(1, Math.round(t));
  const steps = Math.ceil(w);
  for (let i = 0; i <= steps; i++) {
    const fx = x + (w * i) / steps;
    if (fwd) ctx.fillRect(Math.round(fx), Math.round(y + h - (h * i) / steps) - (td >> 1), td, td);
    if (back) ctx.fillRect(Math.round(fx), Math.round(y + (h * i) / steps) - (td >> 1), td, td);
  }
}

/** Rounded box corners ╭╮╰╯ (U+256D-2570) drawn with a quarter-arc stroke so
 *  they curve instead of forming a sharp 90°. */
function drawRoundedCorner(
  ctx: RectCtx,
  cp: number,
  x: number,
  y: number,
  w: number,
  h: number,
  dpr: number,
): void {
  // Align the stroke center + leg endpoints to the exact device-pixel bands that
  // drawLines uses, so the corner's legs line up with the straight │ / ─ in
  // adjacent cells (otherwise a sub-pixel offset reads as a misaligned box).
  const D = (v: number) => Math.round(v * dpr);
  const vt = lightThicknessDev(w, h, dpr); // device px
  ctx.lineWidth = vt / dpr;
  ctx.lineCap = 'butt';
  ctx.strokeStyle = ctx.fillStyle;
  const cx = (D(x + w / 2) - (vt >> 1) + vt / 2) / dpr; // matches drawLines band center
  const cy = (D(y + h / 2) - (vt >> 1) + vt / 2) / dpr;
  const top = D(y) / dpr;
  const bot = D(y + h) / dpr;
  const lft = D(x) / dpr;
  const rgt = D(x + w) / dpr;
  const r = Math.min(w, h) / 2;
  ctx.beginPath!();
  switch (cp) {
    case 0x256d: // ╭ down + right
      ctx.moveTo!(cx, bot);
      ctx.arcTo!(cx, cy, rgt, cy, r);
      ctx.lineTo!(rgt, cy);
      break;
    case 0x256e: // ╮ down + left
      ctx.moveTo!(cx, bot);
      ctx.arcTo!(cx, cy, lft, cy, r);
      ctx.lineTo!(lft, cy);
      break;
    case 0x256f: // ╯ up + left
      ctx.moveTo!(cx, top);
      ctx.arcTo!(cx, cy, lft, cy, r);
      ctx.lineTo!(lft, cy);
      break;
    case 0x2570: // ╰ up + right
      ctx.moveTo!(cx, top);
      ctx.arcTo!(cx, cy, rgt, cy, r);
      ctx.lineTo!(rgt, cy);
      break;
  }
  ctx.stroke!();
}

function drawBlock(ctx: RectCtx, cp: number, x: number, y: number, w: number, h: number, dpr: number): void {
  // Snap every edge to the device-pixel grid so block elements tile seamlessly
  // AND mirrored glyphs (e.g. ▛/▜ for the Claude-logo eyes) split at the SAME
  // device-pixel center. Rounding the half in CSS px (round(w/2)) ignored the
  // cell's fractional origin and double-rounded, making the two eyes unequal.
  const s = (v: number) => Math.round(v * dpr) / dpr;
  const x0 = s(x);
  const x1 = s(x + w);
  const y0 = s(y);
  const y1 = s(y + h);
  // Eighth blocks from the bottom: ▁(2581)..▇(2587), █(2588) full.
  if (cp >= 0x2581 && cp <= 0x2588) {
    const n = cp - 0x2580; // 1..8
    const top = s(y + h - (h * n) / 8);
    ctx.fillRect(x0, top, x1 - x0, y1 - top);
    return;
  }
  // Eighth blocks from the left: ▉(2589)..▏(258f).
  if (cp >= 0x2589 && cp <= 0x258f) {
    const n = 8 - (cp - 0x2588); // 7..1
    const right = s(x + (w * n) / 8);
    ctx.fillRect(x0, y0, right - x0, y1 - y0);
    return;
  }
  const mx = s(x + w / 2); // shared vertical split (device-snapped center)
  const my = s(y + h / 2); // shared horizontal split
  switch (cp) {
    case 0x2580: // ▀ upper half
      return ctx.fillRect(x0, y0, x1 - x0, my - y0);
    case 0x2590: // ▐ right half
      return ctx.fillRect(mx, y0, x1 - mx, y1 - y0);
    case 0x2594: { // ▔ upper eighth
      const b = s(y + h / 8);
      return ctx.fillRect(x0, y0, x1 - x0, b - y0);
    }
    case 0x2595: { // ▕ right eighth
      const l = s(x + (w * 7) / 8);
      return ctx.fillRect(l, y0, x1 - l, y1 - y0);
    }
    case 0x2591: // ░ light shade (25%)
    case 0x2592: // ▒ medium shade (50%)
    case 0x2593: // ▓ dark shade (75%)
      return drawShade(ctx, cp, x, y, w, h);
  }
  // Quadrant blocks 2596..259f: which of the 4 quadrants are filled.
  const Q: Record<number, [boolean, boolean, boolean, boolean]> = {
    // [topLeft, topRight, bottomLeft, bottomRight]
    0x2596: [false, false, true, false], // ▖
    0x2597: [false, false, false, true], // ▗
    0x2598: [true, false, false, false], // ▘
    0x2599: [true, false, true, true], // ▙
    0x259a: [true, false, false, true], // ▚
    0x259b: [true, true, true, false], // ▛
    0x259c: [true, true, false, true], // ▜
    0x259d: [false, true, false, false], // ▝
    0x259e: [false, true, true, false], // ▞
    0x259f: [false, true, true, true], // ▟
  };
  const q = Q[cp];
  if (q) {
    if (q[0]) ctx.fillRect(x0, y0, mx - x0, my - y0);
    if (q[1]) ctx.fillRect(mx, y0, x1 - mx, my - y0);
    if (q[2]) ctx.fillRect(x0, my, mx - x0, y1 - my);
    if (q[3]) ctx.fillRect(mx, my, x1 - mx, y1 - my);
  }
}

/** Shade blocks ░▒▓ as a dither/checkerboard pattern (like xterm's font glyph)
 *  rather than a flat alpha fill, so a shaded bar reads as a texture. Cells are
 *  small and shaded regions are typically tiny, so per-pixel fills are fine. */
function drawShade(ctx: RectCtx, cp: number, x: number, y: number, w: number, h: number): void {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.ceil(x + w);
  const y1 = Math.ceil(y + h);
  for (let py = y0; py < y1; py++) {
    for (let px = x0; px < x1; px++) {
      const on =
        cp === 0x2591
          ? px % 2 === 0 && py % 2 === 0 // 25%
          : cp === 0x2592
            ? (px + py) % 2 === 0 // 50% checkerboard
            : !(px % 2 === 1 && py % 2 === 1); // 75%
      if (on) ctx.fillRect(px, py, 1, 1);
    }
  }
}
