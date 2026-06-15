import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { slugify, buildContent, makeNotesStore } from "./notes-store";

describe("note slug/content", () => {
  it("slugifies safely", () => {
    expect(slugify("Hello World!")).toBe("hello-world");
    expect(slugify("../etc/passwd")).toBe("etc-passwd");
    expect(slugify("")).toBe("untitled");
    expect(slugify("  A  B  ")).toBe("a-b");
  });
  it("builds content with title frontmatter", () => {
    expect(buildContent("Title", "")).toBe("---\ntitle: \"Title\"\n---\n");
    expect(buildContent("Title", "body")).toBe("---\ntitle: \"Title\"\n---\nbody");
  });
});

describe("notes store", () => {
  let dir: string;
  let store: ReturnType<typeof makeNotesStore>;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "verne-notes-"));
    store = makeNotesStore(dir);
  });
  it("create/list/read/write/append round-trip", () => {
    const slug = store.create("My Note", "hello");
    expect(slug).toBe("my-note");
    expect(store.list()).toEqual([{ slug: "my-note", title: "My Note" }]);
    expect(store.read("my-note").body).toBe("hello");
    store.writeBody("my-note", "replaced");
    expect(store.read("My Note").body).toBe("replaced");
    store.append("my-note", "more");
    expect(store.read("my-note").body).toBe("replaced\n\nmore");
    expect(readFileSync(join(dir, "my-note.md"), "utf8")).toContain("title: \"My Note\"");
  });
  it("dedupes slugs on create", () => {
    store.create("Dup", "a");
    expect(store.create("Dup", "b")).toBe("dup-2");
  });
  it("derives title from first H1 then first line then slug", () => {
    writeFileSync(join(dir, "meta.md"), "---\ntitle: \"Metadata\"\n---\n# Body title\n");
    expect(store.read("meta").title).toBe("Metadata");
    writeFileSync(join(dir, "x.md"), "intro line\n# Real Title\n");
    expect(store.list()).toContainEqual({ slug: "x", title: "Real Title" });
    writeFileSync(join(dir, "y.md"), "just text\n");
    expect(store.read("y").title).toBe("just text");
  });
  it("missing dir lists empty", () => {
    expect(makeNotesStore(join(dir, "nope")).list()).toEqual([]);
  });
});
