// src/lib/shortcuts/catalog.test.ts
import { describe, expect, it } from "vitest";
import { SHORTCUT_CATALOG, catalogDefaults, withCatalogFallback } from "./catalog";
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

describe("withCatalogFallback", () => {
  it("keeps the loaded binding when the entry is present", () => {
    const merged = withCatalogFallback([
      { name: "command-palette", label: "Command Palette", category: "Navigation", target: "menu", binding: "Mod+Alt+K" },
    ]);
    expect(merged.find((s) => s.name === "command-palette")?.binding).toBe("Mod+Alt+K");
  });

  it("backfills entries a stale backend never returned", () => {
    // A newly added catalog entry is missing from a main process built before it
    // existed; without the fallback its binding disappears and the key goes dead.
    const merged = withCatalogFallback([
      { name: "command-palette", label: "Command Palette", category: "Navigation", target: "menu", binding: "Mod+K" },
    ]);
    expect(merged).toHaveLength(SHORTCUT_CATALOG.length);
    for (const def of SHORTCUT_CATALOG)
      expect(merged.find((s) => s.name === def.name)?.binding, def.name).toBeTruthy();
  });

  it("drops entries the catalog no longer defines", () => {
    const merged = withCatalogFallback([
      { name: "removed-shortcut", label: "Gone", category: "View", target: "menu", binding: "Mod+9" },
    ]);
    expect(merged.some((s) => s.name === "removed-shortcut")).toBe(false);
  });

  it("falls back to the whole catalog for an empty response", () => {
    expect(withCatalogFallback([])).toEqual(catalogDefaults());
  });
});
