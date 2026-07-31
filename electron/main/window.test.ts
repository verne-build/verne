import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const windowCallbacks = new Map<string, () => void>();
  const fakeWindow = {
    loadFile: vi.fn(),
    loadURL: vi.fn(),
    once: vi.fn((event: string, callback: () => void) => windowCallbacks.set(event, callback)),
    show: vi.fn(),
    webContents: { setWindowOpenHandler: vi.fn() },
  };
  const nativeTheme = {
    themeSource: "system",
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

import { createWindow } from "./window";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.nativeTheme.themeSource = "system";
  mocks.windowCallbacks.clear();
});

describe("createWindow", () => {
  it("uses an opaque background and matches native controls to the app appearance", () => {
    createWindow("dark");

    expect(mocks.nativeTheme.themeSource).toBe("dark");
    expect(mocks.windowOptions).toHaveProperty("backgroundColor", "#0a0a0a");
    expect(mocks.windowOptions).not.toHaveProperty("transparent");
    expect(mocks.windowOptions).not.toHaveProperty("vibrancy");
    expect(mocks.windowOptions).not.toHaveProperty("visualEffectState");
  });
});
