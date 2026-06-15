import { describe, it, expect } from "vitest";
import { build } from "esbuild";
import { resolve } from "node:path";

// Regression guard: the STT worker is loaded in a Node worker_thread via
// `new Worker(out/main/stt-worker.cjs)`. It MUST be a self-contained bundle. A
// previous setup built it as a second rollup entry, which emitted a bare
// `require("./index.cjs")` at the top of the worker — re-running the entire
// Electron main process (protocol.registerSchemesAsPrivileged, app, ...) inside
// a worker_thread where those APIs are undefined, crashing dictation on start.
describe("stt-worker bundle isolation", () => {
  it("bundles without pulling in the main entry or Electron APIs", async () => {
    const result = await build({
      entryPoints: [resolve(__dirname, "stt-worker.ts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node20",
      write: false,
      external: ["electron"],
    });
    const code = result.outputFiles[0].text;

    // Must not re-execute the main process / Electron-only APIs.
    expect(code).not.toContain("index.cjs");
    expect(code).not.toContain("registerSchemesAsPrivileged");
    expect(code).not.toMatch(/require\(["']electron["']\)/);

    // Must still be a functioning worker: message handler + dynamic native load.
    expect(code).toContain("parentPort");
    expect(code).toContain("sherpaModulePath");
  });
});
