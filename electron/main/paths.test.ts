import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";

// paths.ts resolves its exports at import time from process.env, so each case
// sets the env then re-imports via a fresh module registry.
async function loadInternalDataDir(env: Record<string, string | undefined>): Promise<string> {
  vi.resetModules();
  for (const k of ["ELECTRON_RENDERER_URL", "NODE_ENV", "VERNE_INTERNAL_DATA_DIR"]) {
    delete process.env[k];
  }
  Object.assign(process.env, env);
  return (await import("./paths")).internalDataDir;
}

describe("internalDataDir", () => {
  const saved = { ...process.env };
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => {
    for (const k of ["ELECTRON_RENDERER_URL", "NODE_ENV", "VERNE_INTERNAL_DATA_DIR"]) delete process.env[k];
    Object.assign(process.env, saved);
  });

  const prod = join(homedir(), "Library", "Application Support", "build.verne");
  const dev = join(homedir(), "Library", "Application Support", "build.verne-dev");

  it("uses the prod dir for a packaged-style launch (no dev signals)", async () => {
    expect(await loadInternalDataDir({})).toBe(prod);
  });

  it("uses the dev dir when ELECTRON_RENDERER_URL is set", async () => {
    expect(await loadInternalDataDir({ ELECTRON_RENDERER_URL: "http://localhost:5173" })).toBe(dev);
  });

  // Regression: a dev app launched from a terminal *inside* the running prod app
  // inherits prod's VERNE_INTERNAL_DATA_DIR (the daemon injects it into PTYs so
  // in-terminal tooling phones home). The app must ignore it and stay on its own
  // dev dir — otherwise userData/the single-instance lock collide and dev quits.
  it("ignores an inherited VERNE_INTERNAL_DATA_DIR and stays on its own build identity", async () => {
    expect(
      await loadInternalDataDir({
        ELECTRON_RENDERER_URL: "http://localhost:5173",
        VERNE_INTERNAL_DATA_DIR: prod, // leaked from the owning prod instance
      }),
    ).toBe(dev);
  });
});
