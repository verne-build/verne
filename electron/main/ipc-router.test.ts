import { describe, it, expect, vi } from "vitest";
import type { BrowserWindow } from "electron";
import { makeForward } from "./ipc-router";

// Fake window matching only the surface makeForward touches.
function fakeWin(opts: { winDestroyed?: boolean; wcDestroyed?: boolean }) {
  const send = vi.fn();
  const win = {
    isDestroyed: () => opts.winDestroyed ?? false,
    webContents: { isDestroyed: () => opts.wcDestroyed ?? false, send },
  } as unknown as BrowserWindow;
  return { win, send };
}

describe("makeForward", () => {
  it("sends to a live window", () => {
    const { win, send } = fakeWin({});
    makeForward(() => win)("evt", { a: 1 });
    expect(send).toHaveBeenCalledWith("daemon-event", "evt", { a: 1 });
  });

  // Daemon survives app close and keeps streaming; forward must not throw when
  // the window is gone (macOS keeps the app alive after window close).
  it("no-ops when getWindow throws (no window)", () => {
    const fwd = makeForward(() => { throw new Error("no window"); });
    expect(() => fwd("evt", {})).not.toThrow();
  });

  it("no-ops on a destroyed window", () => {
    const { win, send } = fakeWin({ winDestroyed: true });
    makeForward(() => win)("evt", {});
    expect(send).not.toHaveBeenCalled();
  });

  it("no-ops when webContents is destroyed", () => {
    const { win, send } = fakeWin({ wcDestroyed: true });
    makeForward(() => win)("evt", {});
    expect(send).not.toHaveBeenCalled();
  });
});
