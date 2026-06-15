// src/lib/shortcuts/binding.test.ts
import { describe, expect, it } from "vitest";
import { parseBinding, toElectronAccelerator, toDisplayKeys, matchesEvent } from "./binding";

describe("parseBinding", () => {
  it("splits modifiers and key", () => {
    expect(parseBinding("Mod+Shift+P")).toEqual({ mods: ["Mod", "Shift"], key: "P" });
  });
  it("handles a lone key", () => {
    expect(parseBinding("/")).toEqual({ mods: [], key: "/" });
  });
  it("handles backtick key with literal Ctrl", () => {
    expect(parseBinding("Ctrl+`")).toEqual({ mods: ["Ctrl"], key: "`" });
  });
});

describe("toElectronAccelerator", () => {
  it("maps Mod to CmdOrCtrl", () => {
    expect(toElectronAccelerator("Mod+Shift+P")).toBe("CmdOrCtrl+Shift+P");
  });
  it("maps literal Ctrl to Control", () => {
    expect(toElectronAccelerator("Ctrl+Shift+G")).toBe("Control+Shift+G");
  });
  it("keeps Alt and the key", () => {
    expect(toElectronAccelerator("Mod+Alt+B")).toBe("CmdOrCtrl+Alt+B");
  });
});

describe("toDisplayKeys", () => {
  it("uses mac symbols", () => {
    expect(toDisplayKeys("Mod+Shift+P", "mac")).toEqual(["⌘", "⇧", "P"]);
  });
  it("uses literal control glyph", () => {
    expect(toDisplayKeys("Ctrl+`", "mac")).toEqual(["⌃", "`"]);
  });
  it("falls back to words off mac", () => {
    expect(toDisplayKeys("Mod+K", "other")).toEqual(["Ctrl", "K"]);
  });
});

describe("matchesEvent", () => {
  const ev = (o: Partial<KeyboardEvent>): KeyboardEvent =>
    ({ metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, key: "", ...o }) as KeyboardEvent;

  it("matches Mod via metaKey", () => {
    expect(matchesEvent("Mod+K", ev({ metaKey: true, key: "k" }))).toBe(true);
  });
  it("matches Mod via ctrlKey", () => {
    expect(matchesEvent("Mod+K", ev({ ctrlKey: true, key: "k" }))).toBe(true);
  });
  it("rejects when shift required but absent", () => {
    expect(matchesEvent("Mod+Shift+P", ev({ metaKey: true, key: "p" }))).toBe(false);
  });
  it("rejects when extra shift present", () => {
    expect(matchesEvent("Mod+P", ev({ metaKey: true, shiftKey: true, key: "p" }))).toBe(false);
  });
  it("matches shifted slash when the browser reports question mark", () => {
    expect(matchesEvent("Mod+Shift+/", ev({ metaKey: true, shiftKey: true, key: "?" }))).toBe(true);
  });
  it("does not match shifted slash for a plain slash shortcut", () => {
    expect(matchesEvent("Mod+/", ev({ metaKey: true, shiftKey: true, key: "?" }))).toBe(false);
  });
  it("literal Cmd does not match a bare ctrl press", () => {
    expect(matchesEvent("Cmd+D", ev({ ctrlKey: true, key: "d" }))).toBe(false);
  });
  it("literal Cmd matches meta and rejects extra ctrl", () => {
    expect(matchesEvent("Cmd+D", ev({ metaKey: true, key: "d" }))).toBe(true);
    expect(matchesEvent("Cmd+D", ev({ metaKey: true, ctrlKey: true, key: "d" }))).toBe(false);
  });
});
