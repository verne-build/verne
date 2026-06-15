// Renderer paint benchmarks with regression gates. Budgets recalibrated
// 2026-06-11 after instanced damage-driven rewrite: flood avg ~1.8ms, sparse
// ~0.07ms, truecolor ~4.8ms, search1000 ~1.8ms (M-series Mac, headless
// Chromium). Pre-rewrite unoptimized renderer measured ~18ms flood; Phase 0
// per-frame geometry rebuild measured ~2.0ms. Budgets are ~3-4x measured with
// CI/SwiftShader headroom. Treat a budget failure as a real perf regression;
// only raise with before/after numbers.
// 2026-06-11 phase 3 (packed atlas): uniqueGlyphs 67→11ms avg; flood/search budgets tightened.
import { test, expect, type Page } from '@playwright/test';

const COLS = 120;
const ROWS = 40;
const FRAMES = 120;

interface BenchStats {
  frames: number;
  avgMs: number;
  maxMs: number;
  p95Ms: number;
  kind: string;
}

async function bench(page: Page, scenario: string): Promise<BenchStats> {
  await page.goto('/');
  await page.waitForFunction(() => !!window.__harness);
  return page.evaluate(
    ([s, c, r, n]) => window.__harness.bench(s as string, c as number, r as number, n as number),
    [scenario, COLS, ROWS, FRAMES],
  );
}

function report(name: string, s: BenchStats) {
  // eslint-disable-next-line no-console
  console.log(
    `[bench] ${name.padEnd(14)} avg ${s.avgMs.toFixed(2)}ms p95 ${s.p95Ms.toFixed(2)}ms max ${s.maxMs.toFixed(2)}ms (${s.kind}, ${s.frames} frames, ${COLS}x${ROWS})`,
  );
}

test('flood: full-screen rewrite per frame', async ({ page }) => {
  const s = await bench(page, 'flood');
  report('flood', s);
  expect(s.kind).toBe('webgl2');
  expect(s.avgMs).toBeLessThan(4);
  expect(s.p95Ms).toBeLessThan(16);
});

test('sparse: single-row damage per frame', async ({ page }) => {
  const s = await bench(page, 'sparse');
  report('sparse', s);
  expect(s.kind).toBe('webgl2');
  expect(s.avgMs).toBeLessThan(2);
});

test('truecolor: distinct rgb fg+bg every cell', async ({ page }) => {
  const s = await bench(page, 'truecolor');
  report('truecolor', s);
  expect(s.kind).toBe('webgl2');
  expect(s.avgMs).toBeLessThan(8);
  expect(s.p95Ms).toBeLessThan(16);
});

test('uniqueGlyphs: CJK sweep, constant atlas pressure', async ({ page }) => {
  const s = await bench(page, 'uniqueGlyphs');
  report('uniqueGlyphs', s);
  expect(s.kind).toBe('webgl2');
  // Phase 3 packed growing atlas fixed fixed-slot thrash (was ~67ms avg, now
  // ~11ms). p95 still pays first-cycle growth+raster (~130ms) on 20k unique
  // glyphs; steady state is cheap.
  expect(s.avgMs).toBeLessThan(40);
});

test('search: 1000 highlights on a full screen', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => !!window.__harness);
  const s: BenchStats = await page.evaluate(
    ([c, r]) => window.__harness.benchSearch(c, r, 1000, 60),
    [COLS, ROWS],
  );
  report('search1000', s);
  expect(s.kind).toBe('webgl2');
  expect(s.avgMs).toBeLessThan(4);
});
