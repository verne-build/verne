import { describe, it, expect } from 'vitest';
import { lineToTrackY } from './scrollbar';

describe('lineToTrackY', () => {
  it('maps line 0 to the top and the last line near the bottom', () => {
    expect(lineToTrackY(0, 100, 200)).toBe(0);
    expect(lineToTrackY(50, 100, 200)).toBe(100);
    expect(lineToTrackY(100, 100, 200)).toBe(200);
  });
  it('clamps and handles empty', () => {
    expect(lineToTrackY(5, 0, 200)).toBe(0);
    expect(lineToTrackY(999, 100, 200)).toBe(200);
  });
});
