// electron/main/native/shortcuts-cmds.test.ts
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeShortcutsStore } from "./shortcuts-cmds";

const dirs: string[] = [];
function tmpFile(): string {
  const d = mkdtempSync(join(tmpdir(), "sc-"));
  dirs.push(d);
  return join(d, "shortcuts.json");
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("makeShortcutsStore", () => {
  it("returns catalog defaults when no file exists", () => {
    const store = makeShortcutsStore(tmpFile());
    const cp = store.read().find((s) => s.name === "command-palette");
    expect(cp?.binding).toBe("Mod+K");
  });

  it("applies overrides by name", () => {
    const file = tmpFile();
    writeFileSync(file, JSON.stringify({ "command-palette": "Mod+J" }));
    const store = makeShortcutsStore(file);
    expect(store.read().find((s) => s.name === "command-palette")?.binding).toBe("Mod+J");
  });

  it("accel() converts the effective binding", () => {
    const store = makeShortcutsStore(tmpFile());
    expect(store.accel("run-action")).toBe("CmdOrCtrl+Shift+P");
    expect(store.accel("nonexistent")).toBe("");
  });

  it("keeps last-good on invalid JSON after a good load", () => {
    const file = tmpFile();
    writeFileSync(file, JSON.stringify({ "command-palette": "Mod+J" }));
    const store = makeShortcutsStore(file);
    expect(store.read().find((s) => s.name === "command-palette")?.binding).toBe("Mod+J");
    writeFileSync(file, "{ not json");
    store.load();
    expect(store.read().find((s) => s.name === "command-palette")?.binding).toBe("Mod+J");
  });

  it("ignores non-string override values", () => {
    const file = tmpFile();
    writeFileSync(file, JSON.stringify({ "new-file": 123 }));
    const store = makeShortcutsStore(file);
    expect(store.read().find((s) => s.name === "new-file")?.binding).toBe("Mod+N");
  });
});
