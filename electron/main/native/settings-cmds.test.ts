import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { makeSettingsStore, migrate } from "./settings-cmds";
import { DEFAULT_SETTINGS } from "../../../src/lib/defaultSettings";

describe("settings migrate", () => {
  it("renames reviewAgent to defaultAgent", () => {
    const out = migrate({ reviewAgent: "codex", appearance: "dark" });
    expect(out.defaultAgent).toBe("codex");
    expect("reviewAgent" in out).toBe(false);
  });

  it("does not overwrite an existing defaultAgent", () => {
    const out = migrate({ reviewAgent: "codex", defaultAgent: "claude", appearance: "dark" });
    expect(out.defaultAgent).toBe("claude");
    expect("reviewAgent" in out).toBe(false);
  });

  it("leaves settings without reviewAgent untouched", () => {
    const out = migrate({ defaultAgent: "claude", appearance: "dark" });
    expect(out.defaultAgent).toBe("claude");
  });
});

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), "verne-settings-"));
  return { dir, store: makeSettingsStore(join(dir, "settings.json")) };
}

describe("settings store", () => {
  it("returns defaults when the file is missing", () => {
    const { store } = freshStore();
    expect(store.read()).toEqual(DEFAULT_SETTINGS);
    expect(store.read().editorFontSize).toBe(14);
    expect(store.read().terminalFontLigatures).toBe(true);
  });

  it("merges file values over defaults (top level)", () => {
    const { dir, store } = freshStore();
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ editorFontSize: 20 }));
    const s = store.read();
    expect(s.editorFontSize).toBe(20);
    expect(s.terminalRenderer).toBe("webgl"); // default preserved
  });

  it("update inserts and null removes; persists and round-trips", () => {
    const { store } = freshStore();
    const a = store.update({ editorFontSize: 18, defaultEditor: "code" });
    expect(a.editorFontSize).toBe(18);
    expect(a.defaultEditor).toBe("code");
    const b = store.update({ defaultEditor: null });
    expect("defaultEditor" in b).toBe(false);
    expect(store.read().editorFontSize).toBe(18); // persisted
  });

  it("migrates legacy keys on read", () => {
    const { dir, store } = freshStore();
    writeFileSync(join(dir, "settings.json"), JSON.stringify({
      dangerouslySkipPermissions: true,
      autoApproveByDefault: true,
      uiMode: "x",
      theme: "sovngarde",
    }));
    const s = store.read();
    expect("dangerouslySkipPermissions" in s).toBe(false);
    expect("autoApproveByDefault" in s).toBe(false);
    expect("uiMode" in s).toBe(false);
    expect("theme" in s).toBe(false);
    expect(s.appearance).toBe("dark");
    expect(s.darkTheme).toBe("default-dark");
    expect(s.lightTheme).toBe(null);
  });
});
