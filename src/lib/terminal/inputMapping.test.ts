import { describe, it, expect } from 'vitest';
import { keyEventToSemantic, isAppShortcut, mouseButton, pixelToCell } from './inputMapping';
import { Ime } from './ime';
import type { FontMetrics } from './renderer';

const key = (over: Partial<Parameters<typeof keyEventToSemantic>[0]> & { key: string }) => ({
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  ...over,
});

describe('keyEventToSemantic', () => {
  it('sends named special keys with modifiers', () => {
    expect(keyEventToSemantic(key({ key: 'ArrowUp' }))).toEqual({
      key: 'ArrowUp',
      mods: { shift: false, alt: false, ctrl: false, meta: false },
    });
    expect(keyEventToSemantic(key({ key: 'Enter' }))?.key).toBe('Enter');
  });

  it('returns null for plain printable chars (text path)', () => {
    expect(keyEventToSemantic(key({ key: 'a' }))).toBeNull();
    expect(keyEventToSemantic(key({ key: '世' }))).toBeNull();
  });

  it('sends ctrl/alt-modified chars (e.g. Ctrl+V passes through)', () => {
    expect(keyEventToSemantic(key({ key: 'v', ctrlKey: true }))).toEqual({
      key: 'v',
      mods: { shift: false, alt: false, ctrl: true, meta: false },
    });
    expect(keyEventToSemantic(key({ key: 'b', altKey: true }))?.key).toBe('b');
  });

  it('drops bare modifier keys', () => {
    expect(keyEventToSemantic(key({ key: 'Shift' }))).toBeNull();
    expect(keyEventToSemantic(key({ key: 'Meta' }))).toBeNull();
  });

  it('drops meta (Cmd) combos as app shortcuts', () => {
    expect(isAppShortcut(key({ key: 'c', metaKey: true }))).toBe(true);
    expect(keyEventToSemantic(key({ key: 'c', metaKey: true }))).toBeNull();
    expect(isAppShortcut(key({ key: 'v', ctrlKey: true }))).toBe(false);
  });
});

describe('mouse + pixel mapping', () => {
  const metrics: FontMetrics = {
    cellWidth: 8,
    cellHeight: 16,
    baseline: 12,
    fontFamily: 'mono',
    fontSize: 14,
  };

  it('maps browser buttons to terminal codes', () => {
    expect(mouseButton(0)).toBe(0);
    expect(mouseButton(2)).toBe(2);
  });

  it('maps pixels to cells and clamps to the grid', () => {
    expect(pixelToCell(0, 0, metrics, 80, 24)).toEqual({ col: 0, row: 0 });
    expect(pixelToCell(20, 33, metrics, 80, 24)).toEqual({ col: 2, row: 2 });
    expect(pixelToCell(99999, 99999, metrics, 80, 24)).toEqual({ col: 79, row: 23 });
    expect(pixelToCell(-5, -5, metrics, 80, 24)).toEqual({ col: 0, row: 0 });
  });
});

describe('Ime state machine', () => {
  it('emits preedit on start/update and commit on end', () => {
    const ime = new Ime();
    const preedits: string[] = [];
    let committed = '';
    ime.onPreedit = (t) => preedits.push(t);
    ime.onCommit = (t) => {
      committed = t;
    };
    ime.start();
    ime.update('に');
    ime.update('にほ');
    expect(ime.composing).toBe(true);
    ime.end('日本');
    expect(committed).toBe('日本');
    expect(ime.composing).toBe(false);
    expect(preedits).toEqual(['', 'に', 'にほ', '']); // start, updates, clear
  });

  it('cancel clears preedit without committing', () => {
    const ime = new Ime();
    let committed = '';
    ime.onCommit = (t) => {
      committed = t;
    };
    ime.start();
    ime.update('x');
    ime.cancel();
    expect(ime.composing).toBe(false);
    expect(committed).toBe('');
  });

  it('end with empty string does not commit', () => {
    const ime = new Ime();
    let calls = 0;
    ime.onCommit = () => calls++;
    ime.start();
    ime.end('');
    expect(calls).toBe(0);
  });
});
