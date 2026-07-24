// Pixel goldens for the WebGL2 renderer: the style matrix (every attribute,
// CJK/emoji/box-drawing) plus overlay layers, at dpr 1 and 2. Goldens are
// platform-specific (font rasterization differs) — Playwright suffixes them
// with the OS. Update intentionally with: pnpm test:renderer --update-snapshots
import { test, expect } from '@playwright/test';

const COLS = 80;
const ROWS = 24;

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => !!window.__harness);
  // Local fonts (Menlo / Apple Color Emoji) must be ready or glyphs raster blank.
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
});

test('style matrix @ dpr1', async ({ page }) => {
  const kind = await page.evaluate(
    ([c, r]) => window.__harness.renderStyles(c, r, 1),
    [COLS, ROWS],
  );
  expect(kind).toBe('webgl2');
  await expect(page.locator('canvas')).toHaveScreenshot('styles-dpr1.png');
});

test('style matrix @ dpr2', async ({ page }) => {
  const kind = await page.evaluate(
    ([c, r]) => window.__harness.renderStyles(c, r, 2),
    [COLS, ROWS],
  );
  expect(kind).toBe('webgl2');
  await expect(page.locator('canvas')).toHaveScreenshot('styles-dpr2.png');
});

test('selection + search overlays @ dpr1', async ({ page }) => {
  const kind = await page.evaluate(
    ([c, r]) => window.__harness.renderOverlays(c, r, 1),
    [COLS, ROWS],
  );
  expect(kind).toBe('webgl2');
  await expect(page.locator('canvas')).toHaveScreenshot('overlays-dpr1.png');
});

// Archived-snapshot replay: proves the frozen-tab path (Task 4's
// gridStoreFromArchivedSnapshot + StaticGridTransport + read-only
// TerminalController) never touches WebGL2 or WebSocket, retains full
// history, and supports copy.
test('archived snapshot renders via Canvas2D with full history, no socket', async ({ page }) => {
  const kind = await page.evaluate(() => window.__harness.mountArchived(20, 2));
  expect(kind).toBe('canvas2d');
  expect(await page.evaluate(() => window.__harness.webglRequests)).toBe(0);
  expect(await page.evaluate(() => window.__harness.websocketRequests)).toBe(0);
  expect(await page.evaluate(() => window.__harness.totalLines)).toBe(5);
  expect(await page.evaluate(() => window.__harness.copiedText)).toContain('oldest');
  await expect(page.locator('canvas')).toHaveScreenshot('archived-terminal-dpr1.png');
});
