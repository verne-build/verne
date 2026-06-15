import { describe, it, expect } from "vitest";
import { filterCommentsForFile, toAnnotations } from "./reviewAnnotations";
import type { ReviewComment, ReviewContext } from "@/types/shared";

function c(over: Partial<ReviewComment>): ReviewComment {
  return {
    id: "1", scopeKey: "directory:d1", source: "sourceControl",
    relPath: "src/foo.ts", staged: false, side: "additions",
    startLine: 5, endLine: 5, snippet: "x", body: "", createdAt: 0, updatedAt: 0,
    ...over,
  };
}
const ctx: ReviewContext = {
  scopeKey: "directory:d1", source: "sourceControl", relPath: "src/foo.ts", staged: false,
};

describe("filterCommentsForFile", () => {
  it("matches source + relPath + staged", () => {
    const list = [c({ id: "a" }), c({ id: "b", relPath: "other.ts" }), c({ id: "c", staged: true })];
    expect(filterCommentsForFile(list, ctx).map(x => x.id)).toEqual(["a"]);
  });
  it("matches commit sha for commit diffs", () => {
    const cctx: ReviewContext = { scopeKey: "directory:d1", source: "commit", relPath: "src/foo.ts", commitSha: "sha1" };
    const list = [c({ id: "a", source: "commit", commitSha: "sha1" }), c({ id: "b", source: "commit", commitSha: "sha2" })];
    expect(filterCommentsForFile(list, cctx).map(x => x.id)).toEqual(["a"]);
  });
});

describe("toAnnotations", () => {
  it("anchors the annotation at the comment's end line, carrying its id", () => {
    const anns = toAnnotations([c({ id: "x", side: "deletions", startLine: 9, endLine: 12 })]);
    expect(anns).toEqual([{ side: "deletions", lineNumber: 12, metadata: { commentId: "x" } }]);
  });
});
