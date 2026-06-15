// src/lib/shortcuts/catalog.test.ts
import { describe, expect, it } from "vitest";
import { SHORTCUT_CATALOG } from "./catalog";
import { parseBinding } from "./binding";

describe("SHORTCUT_CATALOG", () => {
  it("has unique names", () => {
    const names = SHORTCUT_CATALOG.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });
  it("every default binding parses to a key", () => {
    for (const s of SHORTCUT_CATALOG) {
      expect(parseBinding(s.defaultBinding).key, s.name).not.toBe("");
    }
  });
  it("includes core shortcuts", () => {
    const names = SHORTCUT_CATALOG.map((s) => s.name);
    expect(names).toContain("command-palette");
    expect(names).toContain("new-terminal");
    expect(names).toContain("shortcuts-help");
  });
  it("does not reserve Monaco's line-comment shortcut for help", () => {
    const help = SHORTCUT_CATALOG.find((s) => s.name === "shortcuts-help");
    expect(help?.defaultBinding).toBe("Mod+Shift+/");
  });
});
