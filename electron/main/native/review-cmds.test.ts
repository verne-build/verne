import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeReviewStore, type ReviewComment } from "./review-cmds";

function sample(id: string, scope: string): ReviewComment {
  return {
    id, scopeKey: scope, source: "sourceControl", relPath: "a.ts",
    side: "additions", startLine: 1, endLine: 2, snippet: "x", body: "note",
    createdAt: 1, updatedAt: 1,
  };
}

describe("review store", () => {
  let store: ReturnType<typeof makeReviewStore>;
  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "verne-review-"));
    store = makeReviewStore(join(dir, "review-comments.json"));
  });

  it("round-trips upsert / list / remove / clear by scope", () => {
    store.upsert(sample("a", "s1"));
    store.upsert(sample("b", "s1"));
    store.upsert(sample("c", "s2"));
    expect(store.list("s1").map(c => c.id).sort()).toEqual(["a", "b"]);

    const edited = { ...sample("a", "s1"), body: "edited" };
    store.upsert(edited);
    expect(store.list("s1").find(c => c.id === "a")!.body).toBe("edited");

    store.remove("a");
    expect(store.list("s1").map(c => c.id)).toEqual(["b"]);

    store.clearScope("s2");
    expect(store.list("s2")).toEqual([]);
  });

  it("sorts by relPath, startLine, createdAt", () => {
    store.upsert({ ...sample("x", "s"), relPath: "b.ts", startLine: 1 });
    store.upsert({ ...sample("y", "s"), relPath: "a.ts", startLine: 9 });
    store.upsert({ ...sample("z", "s"), relPath: "a.ts", startLine: 2 });
    expect(store.list("s").map(c => c.id)).toEqual(["z", "y", "x"]);
  });

  it("preserves optional staged/commitSha across the json round-trip", () => {
    store.upsert({ ...sample("o", "s"), staged: true, commitSha: "abc123" });
    const got = store.list("s").find(c => c.id === "o")!;
    expect(got.staged).toBe(true);
    expect(got.commitSha).toBe("abc123");
  });
});
