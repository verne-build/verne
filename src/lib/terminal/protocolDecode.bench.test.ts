import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeFrame } from './gridProtocol';
import { GridStore } from './GridStore';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../tests/fixtures/grid');

describe('protocol decode/apply cost (phase-5 measurement)', () => {
  const manifest = JSON.parse(readFileSync(join(DIR, 'manifest.json'), 'utf8')) as
    { name: string; cells: number }[];

  for (const { name, cells } of manifest) {
    it(`${name}: decode + apply`, () => {
      const bytes = new Uint8Array(readFileSync(join(DIR, `${name}.bin`)));
      const N = 2000;

      // decode timing
      let t = performance.now();
      let frame!: ReturnType<typeof decodeFrame>;
      for (let i = 0; i < N; i++) frame = decodeFrame(bytes);
      const decMs = (performance.now() - t) / N;

      // decode+apply timing (fresh store each iter to include allocation/clone cost)
      t = performance.now();
      for (let i = 0; i < N; i++) {
        const s = new GridStore();
        s.applyFrame(decodeFrame(bytes));
      }
      const decApplyMs = (performance.now() - t) / N;
      const applyMs = decApplyMs - decMs;

      // eslint-disable-next-line no-console
      console.log(
        `[proto-js] ${name.padEnd(16)} decode ${decMs.toFixed(3)}ms  apply ${applyMs.toFixed(3)}ms  total ${decApplyMs.toFixed(3)}ms  (${cells} cells, ${cells ? (decApplyMs * 1000 / cells).toFixed(3) : '-'} µs/cell)`,
      );

      expect(frame).toBeTruthy();
    }, 30_000);
  }
});
