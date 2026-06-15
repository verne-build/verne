import { describe, it, expect } from 'vitest';
import { createRenderer } from './createRenderer';
import { defaultPalette } from './palette';

const metrics = { cellWidth: 8, cellHeight: 16, baseline: 12, fontFamily: 'monospace', fontSize: 13 };
const opts = (preferWebgl: boolean) => ({
  metrics,
  palette: defaultPalette,
  ligatures: false,
  boldIsBright: false,
  minContrast: 1,
  preferWebgl,
});

// Canvas2DRenderer only stores the ctx at construction (no method calls), so a
// bare object is a sufficient stand-in for these fallback-selection tests.
const fakeCtx2d = () => ({}) as unknown as CanvasRenderingContext2D;
const fakeCanvas = (contexts: Record<string, unknown>): HTMLCanvasElement =>
  ({ getContext: (t: string) => contexts[t] ?? null }) as unknown as HTMLCanvasElement;

describe('createRenderer', () => {
  it('uses Canvas2D when WebGL2 is not preferred', () => {
    const c = fakeCanvas({ '2d': fakeCtx2d() });
    expect(createRenderer(c, opts(false)).kind).toBe('canvas2d');
  });

  it('falls back to Canvas2D when the WebGL2 context is unavailable', () => {
    const c = fakeCanvas({ '2d': fakeCtx2d(), webgl2: null });
    expect(createRenderer(c, opts(true)).kind).toBe('canvas2d');
  });
});
