import { describe, it, expect } from "vitest";
import { isPathAllowed } from "./asset-protocol";

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
