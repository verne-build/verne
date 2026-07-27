import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const windowCallbacks = new Map<string, () => void>();
  const fakeWindow = {
    loadFile: vi.fn(),
    loadURL: vi.fn(),
    once: vi.fn((event: string, callback: () => void) => windowCallbacks.set(event, callback)),
    setVibrancy: vi.fn(),
    show: vi.fn(),
    webContents: { setWindowOpenHandler: vi.fn() },
  };
  const nativeTheme = {
    prefersReducedTransparency: false,
    themeSource: "system",
    on: vi.fn(),
    removeListener: vi.fn(),
  };
  return { fakeWindow, nativeTheme, windowCallbacks, windowOptions: undefined as unknown };
});

vi.mock("electron", () => ({
  BrowserWindow: class {
    constructor(options: unknown) {
      mocks.windowOptions = options;
      return mocks.fakeWindow;
    }
  },
  nativeTheme: mocks.nativeTheme,
  shell: { openExternal: vi.fn() },
}));

import { createWindow, getWindowEffectOptions } from "./window";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.nativeTheme.prefersReducedTransparency = false;
  mocks.nativeTheme.themeSource = "system";
  mocks.windowCallbacks.clear();
});

describe("getWindowEffectOptions", () => {
  it("uses native under-window material on macOS", () => {
    expect(getWindowEffectOptions("darwin", false)).toEqual({
      backgroundColor: "#00000000",
      transparent: true,
      vibrancy: "under-window",
      visualEffectState: "active",
    });
  });

  it("keeps the macOS window transparent when Reduce Transparency is enabled", () => {
    expect(getWindowEffectOptions("darwin", true)).toEqual({
      backgroundColor: "#00000000",
      transparent: true,
    });
  });

  it("keeps non-macOS windows opaque", () => {
    expect(getWindowEffectOptions("linux", false)).toEqual({
      backgroundColor: "#0a0a0a",
    });
  });
});

describe("createWindow", () => {
  it("matches native materials to the app appearance before creating the window", () => {
    createWindow("dark");

    expect(mocks.nativeTheme.themeSource).toBe("dark");
  });

  it.runIf(process.platform === "darwin")("tracks macOS Reduce Transparency until the window closes", () => {
    createWindow();
    const update = mocks.nativeTheme.on.mock.calls.find(([event]) => event === "updated")?.[1];

    expect(update).toBeTypeOf("function");
    mocks.nativeTheme.prefersReducedTransparency = true;
    update();
    expect(mocks.fakeWindow.setVibrancy).toHaveBeenCalledWith(null);

    mocks.windowCallbacks.get("closed")?.();
    expect(mocks.nativeTheme.removeListener).toHaveBeenCalledWith("updated", update);
  });
});
