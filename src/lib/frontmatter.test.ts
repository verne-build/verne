import { describe, expect, it } from "vitest";
import { joinFrontmatter, splitFrontmatter, titleFrontmatter } from "./frontmatter";

describe("frontmatter", () => {
  it("splits and rejoins a document without changing metadata", () => {
    const source = "---\ntitle: \"Notes\"\ntags:\n  - work\n---\nBody\n";
    const result = splitFrontmatter(source);
    expect(result).toEqual({
      prefix: "---\ntitle: \"Notes\"\ntags:\n  - work\n---\n",
      body: "Body\n",
    });
    expect(joinFrontmatter(result.prefix, result.body)).toBe(source);
  });

  it("leaves ordinary markdown untouched", () => {
    expect(splitFrontmatter("# Heading\n")).toEqual({ prefix: "", body: "# Heading\n" });
  });

  it("does not treat an unclosed delimiter as frontmatter", () => {
    expect(splitFrontmatter("---\ntitle: nope\nbody")).toEqual({
      prefix: "",
      body: "---\ntitle: nope\nbody",
    });
  });

  it("creates YAML-compatible title metadata", () => {
    expect(titleFrontmatter("A \"quoted\" title")).toBe(
      "---\ntitle: \"A \\\"quoted\\\" title\"\n---\n",
    );
  });
});
