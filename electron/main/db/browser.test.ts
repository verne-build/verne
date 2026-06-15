import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./connection";
import {
  addFavorite,
  removeFavorite,
  getFavorites,
  recordHistory,
  getHistory,
  clearHistory,
  renameFavorite,
  removeHistory,
} from "./browser";

function tmpDb() {
  const dir = mkdtempSync(join(tmpdir(), "verne-browser-"));
  return openDb(join(dir, "verne.db"));
}

describe("browser favorites", () => {
  it("addFavorite then getFavorites returns the row", () => {
    const db = tmpDb();
    addFavorite(db, "/ws/a", "https://example.com", "Example", null);
    const favs = getFavorites(db, "/ws/a");
    expect(favs).toHaveLength(1);
    expect(favs[0].url).toBe("https://example.com");
    expect(favs[0].title).toBe("Example");
    expect(favs[0].faviconUrl).toBeNull();
    expect(favs[0].addedAt).toBeGreaterThan(0);
  });

  it("adding same URL does not duplicate (PK replace)", () => {
    const db = tmpDb();
    addFavorite(db, "/ws/a", "https://example.com", "Example", null);
    addFavorite(db, "/ws/a", "https://example.com", "Example Updated", "https://fav.ico");
    const favs = getFavorites(db, "/ws/a");
    expect(favs).toHaveLength(1);
    expect(favs[0].title).toBe("Example Updated");
    expect(favs[0].faviconUrl).toBe("https://fav.ico");
  });

  it("removeFavorite removes the row", () => {
    const db = tmpDb();
    addFavorite(db, "/ws/a", "https://example.com", "Example", null);
    removeFavorite(db, "/ws/a", "https://example.com");
    expect(getFavorites(db, "/ws/a")).toHaveLength(0);
  });

  it("removeFavorite on missing URL is a no-op", () => {
    const db = tmpDb();
    expect(() => removeFavorite(db, "/ws/a", "https://nothere.com")).not.toThrow();
  });

  it("favorites scoped to workspace_root (isolation)", () => {
    const db = tmpDb();
    addFavorite(db, "/ws/a", "https://example.com", "Example", null);
    expect(getFavorites(db, "/ws/b")).toHaveLength(0);
  });

  it("renameFavorite updates title and preserves addedAt", () => {
    const db = tmpDb();
    addFavorite(db, "/ws/a", "https://example.com", "Example", null);
    const before = getFavorites(db, "/ws/a")[0].addedAt;
    renameFavorite(db, "/ws/a", "https://example.com", "Renamed");
    const favs = getFavorites(db, "/ws/a");
    expect(favs).toHaveLength(1);
    expect(favs[0].title).toBe("Renamed");
    expect(favs[0].addedAt).toBe(before);
  });

  it("renameFavorite on missing URL is a no-op", () => {
    const db = tmpDb();
    expect(() => renameFavorite(db, "/ws/a", "https://nothere.com", "Title")).not.toThrow();
  });
});

describe("browser history", () => {
  it("recordHistory twice on same URL yields ONE row with later visitedAt", async () => {
    const db = tmpDb();
    recordHistory(db, "/ws/a", "https://example.com", "Example", null);
    const t1 = getHistory(db, "/ws/a")[0].visitedAt;
    // small pause to ensure different timestamp
    await new Promise(r => setTimeout(r, 5));
    recordHistory(db, "/ws/a", "https://example.com", "Example v2", null);
    const rows = getHistory(db, "/ws/a");
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Example v2");
    expect(rows[0].visitedAt).toBeGreaterThanOrEqual(t1);
  });

  it("recordHistory for two URLs returns both newest-first", async () => {
    const db = tmpDb();
    recordHistory(db, "/ws/a", "https://a.com", "A", null);
    await new Promise(r => setTimeout(r, 5));
    recordHistory(db, "/ws/a", "https://b.com", "B", null);
    const rows = getHistory(db, "/ws/a");
    expect(rows).toHaveLength(2);
    expect(rows[0].url).toBe("https://b.com");
    expect(rows[1].url).toBe("https://a.com");
  });

  it("clearHistory empties history but leaves favorites intact", () => {
    const db = tmpDb();
    addFavorite(db, "/ws/a", "https://example.com", "Example", null);
    recordHistory(db, "/ws/a", "https://example.com", "Example", null);
    clearHistory(db, "/ws/a");
    expect(getHistory(db, "/ws/a")).toHaveLength(0);
    expect(getFavorites(db, "/ws/a")).toHaveLength(1);
  });

  it("history scoped to workspace_root (isolation)", () => {
    const db = tmpDb();
    recordHistory(db, "/ws/a", "https://example.com", "Example", null);
    expect(getHistory(db, "/ws/b")).toHaveLength(0);
  });

  it("removeHistory deletes only the named URL leaving others", () => {
    const db = tmpDb();
    recordHistory(db, "/ws/a", "https://a.com", "A", null);
    recordHistory(db, "/ws/a", "https://b.com", "B", null);
    removeHistory(db, "/ws/a", "https://a.com");
    const rows = getHistory(db, "/ws/a");
    expect(rows).toHaveLength(1);
    expect(rows[0].url).toBe("https://b.com");
  });

  it("removeHistory leaves favorites untouched", () => {
    const db = tmpDb();
    addFavorite(db, "/ws/a", "https://example.com", "Example", null);
    recordHistory(db, "/ws/a", "https://example.com", "Example", null);
    removeHistory(db, "/ws/a", "https://example.com");
    expect(getHistory(db, "/ws/a")).toHaveLength(0);
    expect(getFavorites(db, "/ws/a")).toHaveLength(1);
  });

  it("getHistory respects limit", () => {
    const db = tmpDb();
    for (let i = 0; i < 5; i++) {
      recordHistory(db, "/ws/a", `https://example.com/${i}`, `Page ${i}`, null);
    }
    expect(getHistory(db, "/ws/a", 3)).toHaveLength(3);
  });
});
