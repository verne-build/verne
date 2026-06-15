// Selection model in logical (line, col) space so it survives reflow. Pure;
// the host supplies a getLineText accessor over screen + history.

export interface Pos {
  line: number;
  col: number;
}
export interface Selection {
  start: Pos;
  end: Pos;
}

/** Order two positions so `start` precedes `end` (by line, then column). */
export function orderSelection(a: Pos, b: Pos): Selection {
  if (a.line < b.line || (a.line === b.line && a.col <= b.col)) return { start: a, end: b };
  return { start: b, end: a };
}

/** Flatten a selection to text. `getMap(line)` supplies the line's text + col
 *  maps; slicing happens in UTF-16 index space so wide chars and astral pairs
 *  stay intact. `isWrapped(l)` returns true when line `l` soft-wraps into the
 *  next; those boundaries are joined with '' instead of '\n'. Defaults to
 *  () => false so existing 2-arg callers are unaffected. */
export function flattenSelection(
  sel: Selection,
  getMap: (line: number) => LineMap,
  isWrapped: (line: number) => boolean = () => false,
): string {
  const { start, end } = sel;
  if (start.line === end.line) {
    const m = getMap(start.line);
    return m.text.slice(colToIndex(m, start.col), colToIndex(m, end.col));
  }
  let out = getMap(start.line).text.slice(colToIndex(getMap(start.line), start.col));
  for (let l = start.line; l < end.line; l++) {
    const sep = isWrapped(l) ? '' : '\n';
    const next =
      l + 1 === end.line
        ? (() => { const last = getMap(end.line); return last.text.slice(0, colToIndex(last, end.col)); })()
        : getMap(l + 1).text;
    out += sep + next;
  }
  return out;
}

/** Cell-col ↔ UTF-16-index maps for one visual line. Built by GridStore.lineMap;
 *  needed because wide chars (1 char, 2 cells), combining marks, and astral
 *  code points (1 char, 2 UTF-16 units) make cell columns ≠ string indices. */
export interface LineMap {
  /** Spacer-stripped line text, trailing whitespace trimmed (== lineText). */
  text: string;
  /** colToIdx[col] → UTF-16 index where that cell's content starts. Spacer cols
   *  map past their wide char; cols beyond the trimmed text map to text.length.
   *  Length = cell count + 1 (sentinel at the end). */
  colToIdx: number[];
  /** idxToCol[i] → cell col owning UTF-16 index i. Length = text.length + 1;
   *  the sentinel maps text.length to the col just past the last content cell. */
  idxToCol: number[];
}

export const colToIndex = (m: LineMap, col: number): number =>
  m.colToIdx[Math.max(0, Math.min(col, m.colToIdx.length - 1))];

export const indexToCol = (m: LineMap, idx: number): number =>
  m.idxToCol[Math.max(0, Math.min(idx, m.idxToCol.length - 1))];

/** Word boundaries around `col` in `text` (for double-click selection). */
export function wordRange(text: string, col: number): { start: number; end: number } {
  const isWord = (c: string) => /[\w./~-]/.test(c);
  if (col >= text.length || !isWord(text[col])) return { start: col, end: col };
  let start = col;
  let end = col;
  while (start > 0 && isWord(text[start - 1])) start--;
  while (end < text.length && isWord(text[end])) end++;
  return { start, end };
}
