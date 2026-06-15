import type { DiffLineAnnotation } from "@pierre/diffs";
import type { ReviewComment, ReviewContext } from "@/types/shared";

export type CommentAnnotation = DiffLineAnnotation<{ commentId: string }>;

/** Comments belonging to the diff currently shown. */
export function filterCommentsForFile(list: ReviewComment[], ctx: ReviewContext): ReviewComment[] {
  return list.filter((c) => {
    if (c.source !== ctx.source || c.relPath !== ctx.relPath) return false;
    if (ctx.source === "sourceControl") return c.staged === ctx.staged;
    return c.commitSha === ctx.commitSha;
  });
}

// Cache annotation objects (and their `metadata`) by comment id. Pierre compares
// annotations by `metadata` *reference* (areDiffLineAnnotationsEqual), so reusing
// the same object across calls — as long as side/endLine are unchanged — lets
// Pierre skip re-slotting that comment's box when an *unrelated* comment changes.
// The box's body is NOT part of the annotation; edits update it reactively inside
// DiffCommentBox without touching annotations at all.
const annotationCache = new Map<string, CommentAnnotation>();

/** Map comments to Pierre line annotations, anchored at each comment's END line
 * so the box renders below the whole selection (GitHub-style). Returns
 * reference-stable annotation objects (see annotationCache).
 *
 * Known limitation: Pierre names the slot `annotation-{side}-{lineNumber}`, so
 * two comments ending on the SAME line and side collide into one slot (only the
 * first renders its box). Multiple comments per line is rare in practice;
 * per-comment offset disambiguation is deferred. */
export function toAnnotations(list: ReviewComment[]): CommentAnnotation[] {
  return list.map((c) => {
    const cached = annotationCache.get(c.id);
    if (cached && cached.side === c.side && cached.lineNumber === c.endLine) return cached;
    const ann: CommentAnnotation = { side: c.side, lineNumber: c.endLine, metadata: { commentId: c.id } };
    annotationCache.set(c.id, ann);
    return ann;
  });
}
