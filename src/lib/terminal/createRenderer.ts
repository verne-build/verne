// Renderer factory + capability gate. Builds a WebGL2 renderer when preferred
// and the context is obtainable, else Canvas2D (which is also the context-loss
// fallback). Keeps backend selection out of the Vue host.

import { Canvas2DRenderer } from './Canvas2DRenderer';
import { WebGL2Renderer } from './WebGL2Renderer';
import { pickRenderer } from './glyphAtlas';
import type { Palette } from './palette';
import type { FontMetrics, TerminalRenderer } from './renderer';

export interface RendererOptions {
  metrics: FontMetrics;
  palette: Palette;
  ligatures: boolean;
  boldIsBright: boolean;
  minContrast: number;
  /** Try WebGL2 first when true (else go straight to Canvas2D). */
  preferWebgl: boolean;
}

export interface CreatedRenderer {
  renderer: TerminalRenderer;
  kind: 'webgl2' | 'canvas2d';
}

/** Build a Canvas2D renderer on `canvas`'s 2D context. */
export function makeCanvas2D(canvas: HTMLCanvasElement, opts: RendererOptions): Canvas2DRenderer {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('terminal: 2d context unavailable');
  return new Canvas2DRenderer(ctx, {
    metrics: opts.metrics,
    palette: opts.palette,
    ligatures: opts.ligatures,
    boldIsBright: opts.boldIsBright,
    minContrast: opts.minContrast,
  });
}

/** Build a renderer for `canvas`. Tries WebGL2 when preferred + available; a
 *  null/throwing `getContext('webgl2')` leaves the canvas context-free, so the
 *  Canvas2D fallback can still claim its 2D context on the same element. */
export function createRenderer(canvas: HTMLCanvasElement, opts: RendererOptions): CreatedRenderer {
  if (pickRenderer({ webgl2: opts.preferWebgl }) === 'webgl2') {
    try {
      const gl = canvas.getContext('webgl2', { alpha: false, antialias: false });
      if (gl) {
        const atlasCanvas = document.createElement('canvas');
        return {
          kind: 'webgl2',
          renderer: new WebGL2Renderer(gl, {
            metrics: opts.metrics,
            palette: opts.palette,
            atlasCanvas,
            boldIsBright: opts.boldIsBright,
            minContrast: opts.minContrast,
            ligatures: opts.ligatures,
          }),
        };
      }
    } catch {
      // WebGL2 unavailable/blocked — fall through to Canvas2D.
    }
  }
  return { kind: 'canvas2d', renderer: makeCanvas2D(canvas, opts) };
}
