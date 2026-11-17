import { describe, it, expect } from "vitest";
import { isPathAllowed, parseByteRange } from "./asset-protocol";

describe("isPathAllowed", () => {
  const root = "/Users/x/project";

  it("allows a file directly under a root", () => {
    expect(isPathAllowed("/Users/x/project/readme.md", [root])).toBe(true);
  });

  it("allows a deeply nested file under a root", () => {
    expect(isPathAllowed("/Users/x/project/src/a/b/c.png", [root])).toBe(true);
  });

  it("allows the exact root path itself", () => {
    expect(isPathAllowed("/Users/x/project", [root])).toBe(true);
  });

  it("rejects a path outside every root (the /etc/passwd exploit)", () => {
    expect(isPathAllowed("/etc/passwd", [root])).toBe(false);
  });

  it("rejects a prefix-spoof sibling dir", () => {
    expect(isPathAllowed("/Users/x/project-evil/secret", [root])).toBe(false);
  });

  it("rejects a resolved `..` traversal that escapes the root", () => {
    // Represents realpath's output after resolving `/Users/x/project/../.ssh/id_rsa`.
    expect(isPathAllowed("/Users/x/.ssh/id_rsa", [root])).toBe(false);
  });

  it("allows a file under any one of multiple roots", () => {
    const roots = ["/opt/resources", root];
    expect(isPathAllowed("/opt/resources/sound.mp3", roots)).toBe(true);
  });

  it("rejects when there are no roots", () => {
    expect(isPathAllowed("/Users/x/project/readme.md", [])).toBe(false);
  });
});

describe("parseByteRange", () => {
  const size = 1000;

  it("parses a closed range", () => {
    expect(parseByteRange("bytes=0-99", size)).toEqual({ start: 0, end: 99 });
  });

  it("parses an open-ended range", () => {
    expect(parseByteRange("bytes=500-", size)).toEqual({ start: 500, end: 999 });
  });

  it("parses a suffix range", () => {
    expect(parseByteRange("bytes=-100", size)).toEqual({ start: 900, end: 999 });
  });

  it("clamps an end past EOF", () => {
    expect(parseByteRange("bytes=900-5000", size)).toEqual({ start: 900, end: 999 });
  });

  it("rejects a start at or past EOF", () => {
    expect(parseByteRange("bytes=1000-", size)).toBe("invalid");
  });

  it("rejects an inverted range", () => {
    expect(parseByteRange("bytes=50-10", size)).toBe("invalid");
  });

  it("ignores unsupported syntax so the caller can send the full body", () => {
    expect(parseByteRange("bytes=0-1,5-6", size)).toBeNull();
    expect(parseByteRange("items=0-1", size)).toBeNull();
  });
});
