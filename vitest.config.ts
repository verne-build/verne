import { resolve } from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

// Node is the default environment (main-process / pure-logic tests). DOM-based
// tests opt in per-file with `// @vitest-environment jsdom`.
export default defineConfig({
  resolve: {
    alias: [{ find: "@", replacement: resolve(__dirname, "src") }],
  },
  test: {
    environment: "node",
    // tests/renderer is a Playwright suite (real Chromium WebGL), not vitest.
    exclude: [...configDefaults.exclude, "tests/renderer/**"],
  },
});
