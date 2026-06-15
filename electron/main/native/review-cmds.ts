import { app } from "electron";
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { registerNative } from "../ipc-router";

export interface ReviewComment {
  id: string;
  scopeKey: string;
  source: "sourceControl" | "commit";
  relPath: string;
  staged?: boolean;
  commitSha?: string;
  side: "additions" | "deletions";
  startLine: number;
  endLine: number;
  snippet: string;
  body: string;
  createdAt: number;
  updatedAt: number;
}

export function makeReviewStore(filePath: string) {
  function readAll(): ReviewComment[] {
    let raw: string;
    try {
      raw = readFileSync(filePath, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; // first run
      console.error(`[review] failed to read ${filePath}:`, e);
      return [];
    }
    try {
      return JSON.parse(raw) as ReviewComment[];
    } catch (e) {
      // Corrupt JSON: preserve it instead of letting the next write clobber it.
      console.error(`[review] corrupt store at ${filePath}; preserving as .corrupt:`, e);
      try { renameSync(filePath, `${filePath}.corrupt-${Date.now()}`); } catch { /* best effort */ }
      return [];
    }
  }
  function writeAll(rows: ReviewComment[]): void {
    mkdirSync(dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(rows));
    renameSync(tmp, filePath); // atomic on same fs — no torn reads
  }
  return {
    list(scopeKey: string): ReviewComment[] {
      return readAll()
        .filter(c => c.scopeKey === scopeKey)
        .sort((a, b) =>
          a.relPath.localeCompare(b.relPath) ||
          a.startLine - b.startLine ||
          a.createdAt - b.createdAt);
    },
    upsert(c: ReviewComment): void {
      const rows = readAll().filter(r => r.id !== c.id);
      rows.push(c);
      writeAll(rows);
    },
    remove(id: string): void {
      writeAll(readAll().filter(r => r.id !== id));
    },
    clearScope(scopeKey: string): void {
      writeAll(readAll().filter(r => r.scopeKey !== scopeKey));
    },
  };
}

export function registerReviewCommands(): void {
  const store = makeReviewStore(join(app.getPath("userData"), "review-comments.json"));
  registerNative("review_list", (p: { scopeKey: string }) => store.list(p.scopeKey));
  registerNative("review_upsert", (p: { comment: ReviewComment }) => { store.upsert(p.comment); return null; });
  registerNative("review_remove", (p: { id: string }) => { store.remove(p.id); return null; });
  registerNative("review_clear_scope", (p: { scopeKey: string }) => { store.clearScope(p.scopeKey); return null; });
}
