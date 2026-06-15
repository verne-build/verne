import { describe, it, expect } from "vitest";
import { normalizeBrowserUrl, labelForUrl, sameBrowserUrl } from "./browserTabs";

describe("normalizeBrowserUrl", () => {
  it("adds https for bare hosts", () => {
    expect(normalizeBrowserUrl("example.com")).toBe("https://example.com");
  });
  it("keeps explicit schemes", () => {
    expect(normalizeBrowserUrl("http://foo.test/x")).toBe("http://foo.test/x");
  });
  it("treats spaces / no-dot as a google search", () => {
    expect(normalizeBrowserUrl("hello world")).toContain("google.com/search?q=");
  });
  it("rewrites bare google.com to www.google.com", () => {
    expect(normalizeBrowserUrl("google.com")).toContain("www.google.com");
  });
  it("rewrites bare google.co.uk to www.google.co.uk", () => {
    expect(normalizeBrowserUrl("google.co.uk")).toContain("www.google.co.uk");
  });
  it("does not double-www an already-prefixed google.com", () => {
    expect(normalizeBrowserUrl("www.google.com")).toContain("www.google.com");
    expect(normalizeBrowserUrl("www.google.com")).not.toContain("www.www");
  });
  it("leaves non-google domains unchanged", () => {
    expect(normalizeBrowserUrl("github.com")).toBe("https://github.com");
  });
});

describe("sameBrowserUrl", () => {
  it("matches identical urls", () => {
    expect(sameBrowserUrl("https://x.com/a", "https://x.com/a")).toBe(true);
  });
  it("ignores a trailing slash", () => {
    expect(sameBrowserUrl("https://x.com", "https://x.com/")).toBe(true);
    expect(sameBrowserUrl("https://x.com/a/", "https://x.com/a")).toBe(true);
  });
  it("ignores the hash", () => {
    expect(sameBrowserUrl("https://x.com/a#top", "https://x.com/a")).toBe(true);
  });
  it("treats the query as significant", () => {
    expect(sameBrowserUrl("https://x.com/s?id=1", "https://x.com/s?id=2")).toBe(false);
  });
  it("distinguishes host and protocol", () => {
    expect(sameBrowserUrl("https://x.com/a", "https://y.com/a")).toBe(false);
    expect(sameBrowserUrl("http://x.com/a", "https://x.com/a")).toBe(false);
  });
  it("falls back to string equality for unparseable input", () => {
    expect(sameBrowserUrl("about:blank", "about:blank")).toBe(true);
    expect(sameBrowserUrl("garbage", "other")).toBe(false);
  });
});

describe("labelForUrl", () => {
  it("uses the host", () => {
    expect(labelForUrl("https://news.ycombinator.com/item?id=1")).toBe("news.ycombinator.com");
  });
  it("falls back to the raw string when unparseable", () => {
    expect(labelForUrl("garbage###")).toBe("garbage###");
  });
  it("labels a blank new tab", () => {
    expect(labelForUrl("about:blank")).toBe("New Tab");
    expect(labelForUrl("")).toBe("New Tab");
  });
});
