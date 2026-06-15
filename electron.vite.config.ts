import { resolve } from "node:path";
import { build as esbuild } from "esbuild";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import type { Plugin } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";

// The STT worker is spawned via `new Worker(out/main/stt-worker.cjs)` in a Node
// worker_thread. It MUST be a fully self-contained bundle: if it were a second
// rollup entry alongside index.ts, rolldown (with our custom cjs `output`)
// emits a bare `require("./index.cjs")` at the top of the worker, which re-runs
// the entire main process — calling Electron-main APIs (protocol/app) that are
// undefined in a worker_thread. Bundling it with an isolated esbuild pass keeps
// it dependency-free. Runs on closeBundle so electron-vite's out/main clean
// (which happens before each build, incl. dev rebuilds) can't wipe it.
function buildMcpServer(): Plugin {
  return {
    name: "build-mcp-server",
    async closeBundle() {
      await esbuild({
        entryPoints: [resolve("electron/main/mcp/mcp-server.ts")],
        outfile: resolve("out/main/mcp-server.cjs"),
        bundle: true,
        platform: "node",
        format: "cjs",
        target: "node20",
        external: ["electron"],
      });
    },
  };
}

function buildSttWorker(): Plugin {
  return {
    name: "build-stt-worker",
    async closeBundle() {
      await esbuild({
        entryPoints: [resolve("electron/main/speech/stt-worker.ts")],
        outfile: resolve("out/main/stt-worker.cjs"),
        bundle: true,
        platform: "node",
        format: "cjs",
        target: "node20",
        // electron is never imported by the worker, but keep it external as a
        // backstop. node builtins + the dynamic require(sherpaModulePath) are
        // left as runtime requires by platform:node.
        external: ["electron"],
      });
    },
  };
}

export default defineConfig({
  main: {
    // `electron` and node builtins MUST stay external so `require("electron")`
    // resolves to Electron's runtime builtin. Without this the bundler inlines
    // the npm `electron` package's launcher (the "Downloading Electron
    // binary..." shim), whose export is the executable path string, so
    // `protocol`/`app`/etc. are undefined and the main process crashes on boot.
    plugins: [externalizeDepsPlugin(), buildSttWorker(), buildMcpServer()],
    build: {
      rollupOptions: {
        input: resolve("electron/main/index.ts"),
        // `electron` lives in devDependencies, so externalizeDepsPlugin won't
        // externalize it — list it explicitly so it resolves to the runtime
        // builtin instead of the npm launcher shim.
        external: ["electron"],
        // Emit CommonJS (.cjs) since the root package is `type: module`
        // (renderer/Vite need ESM) but the Electron main process is CJS.
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve("electron/preload/index.ts"),
        external: ["electron"],
        // Preload runs in a CommonJS sandbox; emit .cjs so it isn't parsed as
        // ESM under the package's `type: module`.
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    root: "src",
    worker: { format: "iife" as const },
    resolve: {
      alias: [
        { find: "@", replacement: resolve("src") },
        { find: /^shiki$/, replacement: resolve("src/lib/shikiLite.ts") },
      ],
    },
    plugins: [
      vue({
        template: {
          // <webview> is an Electron custom element (webviewTag); don't let Vue
          // treat it as a component / emit unknown-element warnings.
          compilerOptions: { isCustomElement: (tag: string) => tag === "webview" },
        },
      }),
      tailwindcss(),
    ],
    build: {
      rollupOptions: {
        input: resolve("src/index.html"),
        // Rolldown (vite 8) is stricter than Rollup about /* #__PURE__ */
        // placement; @vueuse/core ships a misplaced one. Silence it for deps
        // only — keep the warning for our own code.
        onwarn(warning, defaultHandler) {
          if (warning.code === "INVALID_ANNOTATION" && warning.message.includes("node_modules")) return;
          defaultHandler(warning);
        },
      },
    },
  },
});
