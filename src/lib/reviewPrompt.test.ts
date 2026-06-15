import { describe, it, expect } from "vitest";
import { formatReviewPrompt } from "./reviewPrompt";
import type { ReviewComment } from "@/types/shared";

function c(over: Partial<ReviewComment>): ReviewComment {
  return {
    id: "1", scopeKey: "directory:d1", source: "sourceControl",
    relPath: "src/foo.ts", side: "additions", startLine: 42, endLine: 42,
    snippet: "const x = 1;", body: "rename x", createdAt: 0, updatedAt: 0,
    ...over,
  };
}

describe("formatReviewPrompt", () => {
  it("groups comments by file with snippet + note", () => {
    const out = formatReviewPrompt([c({})]);
    expect(out).toContain("### src/foo.ts");
    expect(out).toContain("Line 42:");
    expect(out).toContain("```ts\nconst x = 1;\n```");
    expect(out).toContain("> rename x");
  });

  it("labels multi-line ranges", () => {
    const out = formatReviewPrompt([c({ startLine: 42, endLine: 45 })]);
    expect(out).toContain("Lines 42-45:");
  });

  it("keeps one heading per file across multiple comments", () => {
    const out = formatReviewPrompt([
      c({ id: "1", relPath: "a.ts", startLine: 1 }),
      c({ id: "2", relPath: "a.ts", startLine: 9 }),
      c({ id: "3", relPath: "b.ts", startLine: 2 }),
    ]);
    expect(out.match(/### a\.ts/g)?.length).toBe(1);
    expect(out).toContain("### b.ts");
  });

  it("notes the commit sha for commit-diff comments", () => {
    const out = formatReviewPrompt([c({ source: "commit", commitSha: "abc1234def" })]);
    expect(out).toContain("in commit `abc1234`");
  });

  it("prepends an overall message when given", () => {
    const out = formatReviewPrompt([c({})], "focus on error handling");
    expect(out).toContain("focus on error handling");
    expect(out.indexOf("focus on error handling")).toBeLessThan(out.indexOf("### src/foo.ts"));
  });
});
