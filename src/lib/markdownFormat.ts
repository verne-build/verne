export interface FormatEdit {
  /** Offset in the original text where the replacement starts. */
  from: number;
  /** Offset in the original text where the replacement ends. */
  to: number;
  /** Replacement text. */
  insert: string;
  /** Selection start offset in the resulting text. */
  selFrom: number;
  /** Selection end offset in the resulting text. */
  selTo: number;
}

export function wrapInline(text: string, from: number, to: number, marker: string): FormatEdit {
  const m = marker;
  const ml = m.length;
  const sel = text.slice(from, to);

  if (sel.length >= 2 * ml && sel.startsWith(m) && sel.endsWith(m)) {
    const inner = sel.slice(ml, sel.length - ml);
    return { from, to, insert: inner, selFrom: from, selTo: from + inner.length };
  }
  if (text.slice(from - ml, from) === m && text.slice(to, to + ml) === m) {
    return { from: from - ml, to: to + ml, insert: sel, selFrom: from - ml, selTo: from - ml + sel.length };
  }
  if (from === to) {
    return { from, to, insert: m + m, selFrom: from + ml, selTo: from + ml };
  }
  return { from, to, insert: m + sel + m, selFrom: from + ml, selTo: from + ml + sel.length };
}

function lineBlock(text: string, from: number, to: number): { start: number; end: number } {
  const start = text.lastIndexOf("\n", from - 1) + 1;
  let end = text.indexOf("\n", to);
  if (end === -1) end = text.length;
  return { start, end };
}

const HEADING_RE = /^#{1,6} /;

/** True when there is at least one non-empty line and all of them already match. */
function allLinesPrefixed(lines: string[], re: RegExp): boolean {
  const nonEmpty = lines.filter((l) => l.length > 0);
  return nonEmpty.length > 0 && nonEmpty.every((l) => re.test(l));
}

// Result for a line-level transform. With no original selection (from === to)
// the cursor collapses to the end of the rewritten block so the inserted marker
// is ready to type after; with a selection the whole block stays selected.
function lineResult(start: number, end: number, out: string, collapsed: boolean): FormatEdit {
  const selTo = start + out.length;
  return { from: start, to: end, insert: out, selFrom: collapsed ? selTo : start, selTo };
}

export function setHeading(text: string, from: number, to: number, level: number): FormatEdit {
  const { start, end } = lineBlock(text, from, to);
  const hashes = "#".repeat(level) + " ";
  const lines = text.slice(start, end).split("\n");
  const multi = lines.length > 1;
  const nonEmpty = lines.filter((l) => l.length > 0);
  const allThisLevel = nonEmpty.length > 0 && nonEmpty.every((l) => l.startsWith(hashes));
  const out = lines
    .map((l) => {
      if (multi && l.length === 0) return l;
      const bare = l.replace(HEADING_RE, "");
      return allThisLevel ? bare : hashes + bare;
    })
    .join("\n");
  return lineResult(start, end, out, from === to);
}

export function toggleLinePrefix(text: string, from: number, to: number, prefix: string, prefixRe: RegExp): FormatEdit {
  const { start, end } = lineBlock(text, from, to);
  const lines = text.slice(start, end).split("\n");
  const multi = lines.length > 1;
  const remove = allLinesPrefixed(lines, prefixRe);
  const out = lines
    .map((l) => {
      if (multi && l.length === 0) return l;
      return remove ? l.replace(prefixRe, "") : prefix + l;
    })
    .join("\n");
  return lineResult(start, end, out, from === to);
}

export type ListType = "bullet" | "numbered" | "task";

// Any list marker (task before plain bullet) right after a line's indent.
const LIST_BODY_RE = /^(?:[-*+] \[[ xX]\] |[-*+] |\d+[.)] )/;

// Detects a line already of THIS list type (incl. indent), for toggle-off.
function listOwnRe(type: ListType): RegExp {
  switch (type) {
    case "bullet": return /^\s*[-*+] (?!\[[ xX]\])/;
    case "task": return /^\s*[-*+] \[[ xX]\] /;
    case "numbered": return /^\s*\d+[.)] /;
  }
}

function listMarker(type: ListType, index: number): string {
  switch (type) {
    case "bullet": return "- ";
    case "task": return "- [ ] ";
    case "numbered": return `${index + 1}. `;
  }
}

/**
 * Toggle a list type on the selected lines. Clicking the type a line already
 * has removes it; clicking a different list type SWAPS the marker (strips the
 * existing bullet/number/task marker first) rather than stacking on top.
 */
export function toggleListItem(text: string, from: number, to: number, type: ListType): FormatEdit {
  const { start, end } = lineBlock(text, from, to);
  const lines = text.slice(start, end).split("\n");
  const multi = lines.length > 1;
  const remove = allLinesPrefixed(lines, listOwnRe(type));
  let n = 0;
  const out = lines
    .map((l) => {
      if (multi && l.length === 0) return l;
      const indent = l.match(/^\s*/)![0];
      const body = l.slice(indent.length).replace(LIST_BODY_RE, "");
      if (remove) return indent + body;
      const marker = listMarker(type, n);
      n += 1;
      return indent + marker + body;
    })
    .join("\n");
  return lineResult(start, end, out, from === to);
}

export function insertLink(text: string, from: number, to: number, image: boolean): FormatEdit {
  const sel = text.slice(from, to);
  const lead = image ? "![" : "[";
  const insert = `${lead}${sel}](url)`;
  const urlStart = from + lead.length + sel.length + 2; // +2 = "](" literal
  return { from, to, insert, selFrom: urlStart, selTo: urlStart + 3 };
}

export function insertCodeBlock(text: string, from: number, to: number): FormatEdit {
  const sel = text.slice(from, to);
  const insert = "```\n" + sel + "\n```";
  const inner = from + 4; // +4 = "```\n" opening fence + newline
  return { from, to, insert, selFrom: inner, selTo: inner + sel.length };
}

export function insertTable(text: string, from: number, to: number): FormatEdit {
  const insert = "| Column | Column |\n| --- | --- |\n| Cell | Cell |";
  const selFrom = from + 2;
  return { from, to, insert, selFrom, selTo: selFrom + 6 };
}

/**
 * Decide what pressing Enter on a list/quote line should do (GitHub-style).
 * - `continue`: insert "\n" + `marker` so the next item is ready (numbers increment).
 * - `exit`: the item is empty — clear the marker (clearLen chars) to leave the list.
 * - `null`: not a list line; let the editor handle Enter normally.
 */
export type EnterListResult =
  | { kind: "continue"; marker: string }
  | { kind: "exit"; clearLen: number }
  | null;

export function listContinuation(line: string): EnterListResult {
  // Task list item — must be tested before the plain-bullet rule.
  let m = line.match(/^(\s*)([-*+]) \[[ xX]\]\s?(.*)$/);
  if (m) {
    const [, indent, bullet, content] = m;
    if (content.trim() === "") return { kind: "exit", clearLen: line.length };
    return { kind: "continue", marker: `${indent}${bullet} [ ] ` };
  }
  // Bullet list.
  m = line.match(/^(\s*)([-*+])\s+(.*)$/);
  if (m) {
    const [, indent, bullet, content] = m;
    if (content.trim() === "") return { kind: "exit", clearLen: line.length };
    return { kind: "continue", marker: `${indent}${bullet} ` };
  }
  // Numbered list (1. or 1) ).
  m = line.match(/^(\s*)(\d+)([.)])\s+(.*)$/);
  if (m) {
    const [, indent, num, sep, content] = m;
    if (content.trim() === "") return { kind: "exit", clearLen: line.length };
    return { kind: "continue", marker: `${indent}${Number(num) + 1}${sep} ` };
  }
  // Blockquote.
  m = line.match(/^(\s*)(>+)\s?(.*)$/);
  if (m) {
    const [, indent, gts, content] = m;
    if (content.trim() === "") return { kind: "exit", clearLen: line.length };
    return { kind: "continue", marker: `${indent}${gts} ` };
  }
  return null;
}

export type InlineAction = "bold" | "italic" | "code";
export type LineAction = "h1" | "h2" | "h3" | "bullet" | "numbered" | "task" | "quote";
export type BlockAction = "link" | "image" | "codeblock" | "table";
export type FormatAction = InlineAction | LineAction | BlockAction;

const INLINE_MARKERS: Record<InlineAction, string> = {
  bold: "**",
  italic: "_",
  code: "`",
};

export function applyAction(action: FormatAction, text: string, from: number, to: number): FormatEdit {
  switch (action) {
    case "bold":
    case "italic":
    case "code":
      return wrapInline(text, from, to, INLINE_MARKERS[action]);
    case "h1": return setHeading(text, from, to, 1);
    case "h2": return setHeading(text, from, to, 2);
    case "h3": return setHeading(text, from, to, 3);
    case "bullet": return toggleListItem(text, from, to, "bullet");
    case "task": return toggleListItem(text, from, to, "task");
    case "numbered": return toggleListItem(text, from, to, "numbered");
    case "quote": return toggleLinePrefix(text, from, to, "> ", /^> /);
    case "link": return insertLink(text, from, to, false);
    case "image": return insertLink(text, from, to, true);
    case "codeblock": return insertCodeBlock(text, from, to);
    case "table": return insertTable(text, from, to);
  }
}
