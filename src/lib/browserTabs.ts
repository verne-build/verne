// Whether `input` would be treated as a Google search (vs a direct navigation).
// Single source of truth shared by normalizeBrowserUrl and the address-bar
// suggestions, so the suggestion label always matches what Enter actually does.
export function isSearchQuery(input: string): boolean {
  const url = (input || "").trim();
  if (!url) return false;
  if (/^[a-z]+:\/\//i.test(url)) return false;
  // Browser built-in schemes (about:, data:, blob:, etc.) navigate directly.
  if (/^[a-z]+:/i.test(url) && !url.includes(" ")) return false;
  return !url.includes(".") || url.includes(" ");
}

export function normalizeBrowserUrl(input: string): string {
  const url = (input || "").trim();
  if (!url) return "";
  if (/^[a-z]+:\/\//i.test(url)) return url;
  // Pass through browser built-in schemes (about:, data:, blob:, etc.)
  if (/^[a-z]+:/i.test(url) && !url.includes(" ")) return url;
  if (isSearchQuery(url)) {
    return "https://www.google.com/search?q=" + encodeURIComponent(url);
  }
  const full = "https://" + url;
  // Rewrite bare google.<tld> → www.google.<tld> to skip the 301 that
  // triggers Google's legacy/no-JS fallback page.
  try {
    const u = new URL(full);
    if (/^google\.[a-z.]{2,}$/.test(u.hostname)) {
      u.hostname = "www." + u.hostname;
      return u.href;
    }
  } catch {
    // malformed — return as-is
  }
  return full;
}

// Whether two URLs point at the "same page" for tab-reuse purposes. Tolerant of
// trailing-slash and #hash differences; host compared case-insensitively. Query
// string IS significant (?id=1 ≠ ?id=2). Unparseable inputs fall back to exact
// string equality.
export function sameBrowserUrl(a: string, b: string): boolean {
  if (a === b) return true;
  let ua: URL, ub: URL;
  try { ua = new URL(a); ub = new URL(b); } catch { return false; }
  if (ua.protocol !== ub.protocol) return false;
  if (ua.host.toLowerCase() !== ub.host.toLowerCase()) return false;
  const path = (u: URL) => u.pathname.replace(/\/+$/, "") || "/";
  if (path(ua) !== path(ub)) return false;
  return ua.search === ub.search;
}

export function labelForUrl(url: string): string {
  if (!url || url === "about:blank") return "New Tab";
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

export type BrowserLoadError = { title: string; description: string };

// Turn an Electron did-fail-load into the empty-state error screen's text, or
// null when the failure should be ignored: ERR_ABORTED (-3, fired on user stop
// or redirect-interrupted loads) and sub-frame failures (ads/trackers, not the
// page itself). Description names the host so it reads like a real browser.
export function browserLoadError(
  errorCode: number,
  errorDescription: string,
  validatedURL: string,
  isMainFrame: boolean,
): BrowserLoadError | null {
  if (!isMainFrame) return null;
  if (errorCode === -3 || errorDescription === "ERR_ABORTED") return null;
  let host = "";
  try { host = new URL(validatedURL).hostname; } catch { /* not a parseable url */ }
  const who = host || validatedURL || "this site";
  return { title: "Can't reach this site", description: `${who} could not be loaded.` };
}
