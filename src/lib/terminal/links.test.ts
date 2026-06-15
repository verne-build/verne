import { describe, it, expect } from 'vitest';
import { detectLinks, linkAt } from './links';

describe('detectLinks', () => {
  it('detects URLs', () => {
    const m = detectLinks('see https://chatgpt.com/codex?app-landing-page=true now');
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ kind: 'url', value: 'https://chatgpt.com/codex?app-landing-page=true' });
  });

  it('detects absolute and home paths', () => {
    const m = detectLinks('cd ~/Repos/verne-electron && open /etc/hosts');
    expect(m.map((x) => x.value)).toEqual(['~/Repos/verne-electron', '/etc/hosts']);
    expect(m.every((x) => x.kind === 'path')).toBe(true);
  });

  it('detects repo-relative paths with an extension', () => {
    const m = detectLinks('edit electron/main/window.ts please');
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ kind: 'path', value: 'electron/main/window.ts' });
  });

  it('does not match slashless words or version numbers', () => {
    expect(detectLinks('gpt-5.5 medium')).toHaveLength(0);
    expect(detectLinks('a/b without extension')).toHaveLength(0);
  });

  it('does not double-claim the path inside a URL', () => {
    const m = detectLinks('https://example.com/path/to/file.ts');
    expect(m).toHaveLength(1);
    expect(m[0].kind).toBe('url');
  });

  it('linkAt finds the link covering a column', () => {
    const m = detectLinks('x electron/main/window.ts');
    const hit = linkAt(m, 5); // inside the path (starts at col 2)
    expect(hit?.value).toBe('electron/main/window.ts');
    expect(linkAt(m, 0)).toBeUndefined();
  });
});
