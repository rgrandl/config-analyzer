import { describe, expect, it } from 'vitest';
import { keyedUniform } from '../../../src/engine/simulator/keyedRandom';

describe('keyedUniform', () => {
  it('returns the same value for the same key, whenever it is asked', () => {
    // Plan: draw the same key twice, with other draws in between.
    // Verifies: identical values; a draw depends only on its key.
    const first = keyedUniform(42, 812, 7, 2);
    keyedUniform(42, 1, 2, 3);
    expect(keyedUniform(42, 812, 7, 2)).toBe(first);
  });

  it('gives different values for keys that differ in any part', () => {
    // Plan: vary the seed, each key part, and the order of parts.
    // Verifies: all values are distinct.
    const values = [
      keyedUniform(42, 1, 2, 3),
      keyedUniform(43, 1, 2, 3),
      keyedUniform(42, 2, 2, 3),
      keyedUniform(42, 1, 3, 3),
      keyedUniform(42, 1, 2, 4),
      keyedUniform(42, 3, 2, 1),
    ];
    expect(new Set(values).size).toBe(values.length);
  });

  it('is roughly uniform on the open interval (0, 1)', () => {
    // Plan: draw 100 000 values keyed by index and count them in 10 equal bins.
    // Verifies: every value is strictly between 0 and 1, the mean is 0.5 ± 0.01, and each bin holds 10 000 ± 5%.
    const bins = new Array<number>(10).fill(0);
    let sum = 0;
    for (let i = 0; i < 100_000; i++) {
      const u = keyedUniform(7, 1, i);
      expect(u > 0 && u < 1).toBe(true);
      sum += u;
      bins[Math.floor(u * 10)]! += 1;
    }
    expect(sum / 100_000).toBeCloseTo(0.5, 1);
    for (const count of bins) expect(Math.abs(count - 10_000)).toBeLessThan(500);
  });
});
