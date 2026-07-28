import { resolve } from "node:path";
import { configDefaults, defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";

// Node is the default environment (main-process / pure-logic tests). DOM-based
// tests opt in per-file with `// @vitest-environment jsdom`.
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: [{ find: "@", replacement: resolve(__dirname, "src") }],
  },
  test: {
    environment: "node",
    // tests/renderer is a Playwright suite (real Chromium WebGL), not vitest.
    // Local worktrees and the project-local pnpm store contain copied tests.
    exclude: [
      ...configDefaults.exclude,
      "tests/renderer/**",
      ".worktrees/**",
      ".claude/worktrees/**",
      ".pnpm-store/**",
    ],
  },
});
