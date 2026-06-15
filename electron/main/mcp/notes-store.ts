import { readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";

export interface NoteMeta { slug: string; title: string; }
export interface NoteContent { slug: string; title: string; body: string; }

export function slugify(input: string): string {
  let out = "";
  let prevDash = false;
  for (const c of input.trim()) {
    if (/[\p{L}\p{N}]/u.test(c)) {
      out += c.toLowerCase();
      prevDash = false;
    } else if (out.length > 0 && !prevDash) {
      out += "-";
      prevDash = true;
    }
  }
  out = out.replace(/^-+|-+$/g, "");
  return out.length > 0 ? out : "untitled";
}

export function buildContent(title: string, body: string): string {
  return `---\ntitle: ${JSON.stringify(title)}\n---\n${body}`;
}

function splitFrontmatter(content: string): { prefix: string; body: string } {
  const match = /^(---\r?\n[\s\S]*?\r?\n---\r?\n?)/.exec(content);
  if (!match) return { prefix: "", body: content };
  return { prefix: match[1], body: content.slice(match[1].length) };
}

function frontmatterTitle(prefix: string): string | null {
  for (const line of prefix.split(/\r?\n/).slice(1)) {
    if (!line.startsWith("title:")) continue;
    const value = line.slice("title:".length).trim();
    if (!value) return null;
    if (value.startsWith("\"")) {
      try { return JSON.parse(value); } catch { /* fall through */ }
    }
    return value.replace(/^'|'$/g, "");
  }
  return null;
}

function deriveTitle(content: string, slug: string): string {
  const { prefix, body } = splitFrontmatter(content);
  const metadataTitle = frontmatterTitle(prefix);
  if (metadataTitle) return metadataTitle;
  const lines = body.split("\n");
  for (const l of lines) {
    const m = /^#\s+(.+)$/.exec(l.trim());
    if (m) return m[1].trim();
  }
  for (const l of lines) {
    const t = l.replace(/^[#\s]+/, "").trim();
    if (t) return t;
  }
  return slug;
}

/** Storage dir for a workspace root — mirrors Rust paths::notes_dir. */
export function notesDir(internalDataDir: string, workspaceRoot: string): string {
  const hash = createHash("sha256").update(workspaceRoot).digest("hex");
  return join(internalDataDir, "notes", hash);
}

export function makeNotesStore(dir: string) {
  function pathFor(name: string): string {
    return join(dir, `${slugify(name)}.md`);
  }
  function writeAtomic(target: string, content: string): void {
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.tmp.${process.pid}.${randomBytes(4).toString("hex")}`);
    writeFileSync(tmp, content);
    renameSync(tmp, target);
  }
  return {
    list(): NoteMeta[] {
      let files: string[];
      try { files = readdirSync(dir); } catch { return []; }
      return files
        .filter((f) => f.endsWith(".md"))
        .map((f) => {
          const slug = f.slice(0, -3);
          const title = deriveTitle(readFileSync(join(dir, f), "utf8"), slug);
          return { slug, title };
        })
        .sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()));
    },
    read(name: string): NoteContent {
      const slug = slugify(name);
      const content = readFileSync(join(dir, `${slug}.md`), "utf8");
      return {
        slug,
        title: deriveTitle(content, slug),
        body: splitFrontmatter(content).body,
      };
    },
    create(title: string, body: string): string {
      let slug = slugify(title);
      if (existsSync(join(dir, `${slug}.md`))) {
        let n = 2;
        while (existsSync(join(dir, `${slug}-${n}.md`))) n++;
        slug = `${slug}-${n}`;
      }
      writeAtomic(join(dir, `${slug}.md`), buildContent(title, body));
      return slug;
    },
    writeBody(name: string, content: string): string {
      const slug = slugify(name);
      const file = join(dir, `${slug}.md`);
      let prefix = buildContent(name, "");
      if (existsSync(file)) {
        const current = readFileSync(file, "utf8");
        prefix = splitFrontmatter(current).prefix || buildContent(deriveTitle(current, slug), "");
      }
      writeAtomic(file, `${prefix}${content}`);
      return slug;
    },
    append(name: string, text: string): string {
      const slug = slugify(name);
      const file = join(dir, `${slug}.md`);
      let next = text;
      if (existsSync(file)) {
        const cur = readFileSync(file, "utf8");
        next = cur.length ? `${cur}\n\n${text}` : text;
      } else {
        next = buildContent(name, text);
      }
      writeAtomic(file, next);
      return slug;
    },
  };
}
