import type { ReviewComment } from "@/types/shared";

function langFor(relPath: string): string {
  const ext = relPath.split(".").pop() ?? "";
  return ext === relPath ? "" : ext;
}

function rangeLabel(c: ReviewComment): string {
  return c.startLine === c.endLine ? `Line ${c.startLine}:` : `Lines ${c.startLine}-${c.endLine}:`;
}

function blockquote(text: string): string {
  return text.split("\n").map((l) => `> ${l}`).join("\n");
}

/** Group review comments by file into a single markdown prompt for an agent.
 * `overall` is an optional top-level message that steers the whole review. */
export function formatReviewPrompt(comments: ReviewComment[], overall?: string): string {
  if (comments.length === 0) return "";

  const byFile = new Map<string, ReviewComment[]>();
  for (const c of comments) {
    const arr = byFile.get(c.relPath) ?? [];
    arr.push(c);
    byFile.set(c.relPath, arr);
  }

  const blocks: string[] = ["Address these review comments on the working changes:", ""];
  const overallText = overall?.trim();
  if (overallText) blocks.push(overallText, "");

  for (const [relPath, list] of byFile) {
    const sorted = [...list].sort((a, b) => a.startLine - b.startLine);
    const sha = sorted[0].source === "commit" && sorted[0].commitSha
      ? ` (in commit \`${sorted[0].commitSha.slice(0, 7)}\`)`
      : "";
    blocks.push(`### ${relPath}${sha}`);
    const lang = langFor(relPath);
    for (const c of sorted) {
      blocks.push(rangeLabel(c));
      blocks.push("```" + lang);
      blocks.push(c.snippet);
      blocks.push("```");
      if (c.body.trim()) blocks.push(blockquote(c.body));
      blocks.push("");
    }
  }
  return blocks.join("\n").trimEnd() + "\n";
}
