import { defineConfig } from '@playwright/test';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));

// Renderer benchmark + pixel-golden suite. Runs the harness page (real
// GridStore + WebGL2Renderer) in headless Chromium. Workers=1: benchmarks
// share one GPU/SwiftShader — parallel runs skew timings.
export default defineConfig({
  testDir: here,
  testMatch: '*.spec.ts',
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: {
    toHaveScreenshot: {
      // Text AA differs slightly across GPU/driver revs; tolerate a thin
      // edge-pixel band but catch layout/color/glyph regressions.
      maxDiffPixelRatio: 0.01,
    },
  },
  use: {
    baseURL: 'http://localhost:5199',
    viewport: { width: 1500, height: 1000 },
    deviceScaleFactor: 1,
  },
  webServer: {
    command: 'pnpm exec vite --config tests/renderer/vite.config.ts',
    url: 'http://localhost:5199',
    reuseExistingServer: true,
    cwd: `${here}/../..`,
  },
});
