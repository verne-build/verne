import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./connection";
import { getAppState, setAppState } from "./appState";

function tmpDb() {
  const dir = mkdtempSync(join(tmpdir(), "verne-appstate-"));
  return openDb(join(dir, "verne.db"));
}

describe("appState", () => {
  it("returns null for unknown key", () => {
    const db = tmpDb();
    expect(getAppState(db, "nope")).toBeNull();
  });

  it("set and get round-trip", () => {
    const db = tmpDb();
    setAppState(db, "lastActiveDirectoryId", "dir-123");
    expect(getAppState(db, "lastActiveDirectoryId")).toBe("dir-123");
  });

  it("set null clears value", () => {
    const db = tmpDb();
    setAppState(db, "k", "v");
    setAppState(db, "k", null);
    expect(getAppState(db, "k")).toBeNull();
  });

  it("upserts existing key", () => {
    const db = tmpDb();
    setAppState(db, "k", "first");
    setAppState(db, "k", "second");
    expect(getAppState(db, "k")).toBe("second");
  });
});
