import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => unknown>(),
  nativeTheme: { themeSource: "system" },
}));

vi.mock("electron", () => ({ nativeTheme: mocks.nativeTheme }));
vi.mock("../ipc-router", () => ({
  registerNative: (name: string, handler: (...args: any[]) => unknown) => {
    mocks.handlers.set(name, handler);
  },
}));
vi.mock("../paths", () => ({
  internalDataDir: `/tmp/verne-native-appearance-test-${process.pid}`,
}));
vi.mock("./terminal-colors", () => ({
  pushTerminalColorsToDaemon: vi.fn(),
}));

import { registerSettingsCommands } from "./settings-cmds";

beforeEach(() => {
  mocks.handlers.clear();
  mocks.nativeTheme.themeSource = "system";
});

describe("settings native appearance", () => {
  it("updates native materials when the app appearance changes", async () => {
    const sidecar = { request: vi.fn().mockResolvedValue(undefined) };
    registerSettingsCommands(sidecar as never);

    const updateSettings = mocks.handlers.get("update_settings");
    expect(updateSettings).toBeTypeOf("function");
    await updateSettings?.({ settings: { appearance: "dark" } }, undefined);

    expect(mocks.nativeTheme.themeSource).toBe("dark");
  });
});
