// Regex link detection over a line's text (OSC-8 hyperlinks are surfaced
// separately by the emulator). Returns ranges for hover/click.

export type LinkKind = 'url' | 'path';

export interface LinkMatch {
  start: number;
  len: number;
  kind: LinkKind;
  value: string;
}

const URL_RE = /https?:\/\/[^\s'"()]+/g;
// Absolute, home, or explicit-relative paths. The leading boundary (not preceded
// by a path char) stops it claiming a mid-token slash, e.g. the `/main/window.ts`
// inside `electron/main/window.ts` — that's left for REL_PATH_RE.
const PATH_RE = /(?<![\w./~-])(?:~|\.{1,2})?\/[\w.\-/]+/g;
// Bare repo-relative paths: ≥1 `dir/` segment then `file.ext`. The required slash
// + extension keep plain word pairs / version numbers from matching (e.g. matches
// `electron/main/window.ts`, not `gpt-5.5` or `a/b`).
const REL_PATH_RE = /(?:[\w.\-]+\/)+[\w.\-]+\.[A-Za-z0-9]+/g;

/** Detect URLs and file paths in `text`. Precedence on overlap: URL → absolute
 *  path → relative path (so a path inside a URL isn't double-claimed). */
export function detectLinks(text: string): LinkMatch[] {
  const out: LinkMatch[] = [];
  const taken: boolean[] = new Array(text.length).fill(false);
  const claim = (start: number, len: number) => {
    for (let i = start; i < start + len; i++) taken[i] = true;
  };

  for (const m of text.matchAll(URL_RE)) {
    const start = m.index!;
    out.push({ start, len: m[0].length, kind: 'url', value: m[0] });
    claim(start, m[0].length);
  }
  for (const m of text.matchAll(PATH_RE)) {
    const start = m.index!;
    if (taken[start]) continue;
    out.push({ start, len: m[0].length, kind: 'path', value: m[0] });
    claim(start, m[0].length);
  }
  for (const m of text.matchAll(REL_PATH_RE)) {
    const start = m.index!;
    if (taken[start]) continue;
    out.push({ start, len: m[0].length, kind: 'path', value: m[0] });
    claim(start, m[0].length);
  }
  return out.sort((a, b) => a.start - b.start);
}

/** The link covering `col`, if any. */
export function linkAt(matches: LinkMatch[], col: number): LinkMatch | undefined {
  return matches.find((m) => col >= m.start && col < m.start + m.len);
}
