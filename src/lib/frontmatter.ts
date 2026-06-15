export interface FrontmatterDocument {
  prefix: string;
  body: string;
}

const FRONTMATTER = /^(---\r?\n[\s\S]*?\r?\n---\r?\n?)/;

export function splitFrontmatter(content: string): FrontmatterDocument {
  const match = FRONTMATTER.exec(content);
  if (!match) return { prefix: "", body: content };
  return {
    prefix: match[1],
    body: content.slice(match[1].length),
  };
}

export function joinFrontmatter(prefix: string, body: string): string {
  return prefix + body;
}

export function titleFrontmatter(title: string): string {
  return `---\ntitle: ${JSON.stringify(title)}\n---\n`;
}
