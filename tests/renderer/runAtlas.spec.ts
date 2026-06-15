// Regression: a ligature glyph that overflows its run-atlas shelf (tall/accent/
// descender, e.g. Nerd Font icons + ligatures) must not leave lit pixels below
// its slot — the raster clip + shelf padding confine it. Without them, overflow
// texels bleed into the next shelf's sampled region and render as tinted specks
// on text (WebGL-only, since Canvas2D draws glyphs directly with no atlas).
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => !!window.__harness);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
});

for (const dpr of [1, 2]) {
  test(`run-atlas overflow bleed @ dpr${dpr}`, async ({ page }) => {
    // 30px font crammed into a 16px cell → ascender/descender overflow the shelf.
    const res = await page.evaluate((d) => window.__harness.runAtlasOverflowBleed(d, 30, 16), dpr);
    console.log(`overflow dpr${dpr}`, JSON.stringify(res, null, 2));
    expect(res.kind).toBe('webgl2');
    expect(res.lit, `${res.lit} lit px below slot; samples ${JSON.stringify(res.samples)}`).toBe(0);
  });
}
