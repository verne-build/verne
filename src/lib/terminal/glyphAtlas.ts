// Glyph atlas packing for the WebGL2 renderer. The texture upload /
// rasterization lives in WebGL2Renderer; THIS module owns the pure mapping of
// "glyph key → atlas position", which is the part worth testing. Color is
// per-instance (not baked into the atlas), so it is NOT part of the key.

import type { Cell } from './gridProtocol';
import { FLAG } from './gridProtocol';

const STYLE_MASK = FLAG.BOLD | FLAG.ITALIC;

/** Atlas key for a cell: code point + style bits + combining marks + width.
 *  Excludes color (per-instance) and non-glyph flags (inverse/underline). */
export function glyphKey(cell: Cell): string {
  const style = cell.flags & STYLE_MASK;
  const zw = cell.zw && cell.zw.length ? `+${cell.zw.join(',')}` : '';
  return `${cell.cp}:${style}:${cell.width}${zw}`;
}

/** Packed-shelf atlas: fixed-height rows (`rowH`), variable-width entries.
 *  Backs both the glyph atlas and the ligature-run atlas. Pure — the canvas
 *  raster + GL upload live in the renderer. reset() bumps `generation` so
 *  renderers caching entry coords/UVs can invalidate (same contract Phase 2
 *  built for slot eviction). */
export class AtlasPacker {
  width: number;
  height: number;
  readonly rowH: number;
  /** Bumped on reset(): every cached coord/UV is invalid. */
  generation = 0;
  private entries = new Map<string, { x: number; y: number }>();
  private shelves: { y: number; nextX: number }[] = [];

  constructor(width: number, height: number, rowH: number) {
    this.width = width;
    this.height = height;
    this.rowH = rowH;
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: string): { x: number; y: number } | undefined {
    return this.entries.get(key);
  }

  /** Place a `w`-wide entry; null when nothing fits (caller grows or resets). */
  allocate(key: string, w: number): { x: number; y: number; isNew: boolean } | null {
    const hit = this.entries.get(key);
    if (hit) return { ...hit, isNew: false };
    for (const s of this.shelves) {
      if (s.nextX + w <= this.width) {
        const e = { x: s.nextX, y: s.y };
        s.nextX += w;
        this.entries.set(key, e);
        return { ...e, isNew: true };
      }
    }
    const y = this.shelves.length ? this.shelves[this.shelves.length - 1].y + this.rowH : 0;
    if (y + this.rowH > this.height || w > this.width) return null;
    this.shelves.push({ y, nextX: w });
    const e = { x: 0, y };
    this.entries.set(key, e);
    return { ...e, isNew: true };
  }

  /** Extend the atlas (canvas grew). Entries and shelf fill survive. */
  grow(width: number, height: number): void {
    this.width = Math.max(this.width, width);
    this.height = Math.max(this.height, height);
  }

  /** Drop everything (atlas full at max size, or raster scale changed). */
  reset(): void {
    this.entries.clear();
    this.shelves = [];
    this.generation++;
  }
}

export interface RendererCaps {
  webgl2: boolean;
}

/** Pick the renderer backend; WebGL2 when available, else Canvas2D. */
export function pickRenderer(caps: RendererCaps): 'webgl2' | 'canvas2d' {
  return caps.webgl2 ? 'webgl2' : 'canvas2d';
}
