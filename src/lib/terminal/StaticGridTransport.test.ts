import { describe, it, expect } from 'vitest';
import { StaticGridTransport } from './StaticGridTransport';
import { GridStore } from './GridStore';

describe('StaticGridTransport', () => {
  it('wraps the given store and accepts no socket/factory', () => {
    const store = new GridStore();
    const t = new StaticGridTransport(store);
    expect(t.store).toBe(store);
    // Only the store is a constructor arg — nothing socket-shaped is created.
    expect(StaticGridTransport.length).toBe(1);
  });

  it('is a no-op for every input call', () => {
    const t = new StaticGridTransport(new GridStore());
    expect(() => {
      t.sendKey('ArrowUp', {});
      t.sendText('hi');
      t.sendPaste('blob');
      t.sendMouse('down', 0, 1, 1, {});
    }).not.toThrow();
  });

  it('fetch/cancel/search/resize are no-ops (fetch + search return 0)', () => {
    const t = new StaticGridTransport(new GridStore());
    expect(t.fetchHistory(0, 10)).toBe(0);
    expect(t.search('foo', { caseSensitive: true })).toBe(0);
    expect(() => {
      t.cancelHistory(1);
      t.cancelAllFetches();
      t.resize(80, 24);
      t.dispose();
    }).not.toThrow();
  });
});
