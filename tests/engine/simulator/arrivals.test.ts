import { describe, expect, it } from 'vitest';
import { poissonArrivals } from '../../../src/engine/simulator/arrivals';
import { scenario } from '../../helpers/fixtures';

describe('poissonArrivals', () => {
  const sixtySeconds = scenario({ rps: 140, durationMs: 60_000, seed: 42 });

  it('produces sorted times within the run, about rps × duration of them', () => {
    // Plan: generate the demo's traffic: 140 requests/s for 60 s.
    // Verifies: times are increasing and within [0, 60 000), and there are 8400 ± 3% of them.
    const arrivals = poissonArrivals(sixtySeconds);
    arrivals.forEach((time, index) => {
      expect(time).toBeGreaterThanOrEqual(index === 0 ? 0 : (arrivals[index - 1] ?? 0));
      expect(time).toBeLessThan(60_000);
    });
    expect(Math.abs(arrivals.length - 8400)).toBeLessThan(8400 * 0.03);
  });

  it('is determined by the seed', () => {
    // Plan: generate twice with seed 42 and once with seed 43.
    // Verifies: the same seed gives identical lists; another seed gives a different one.
    expect(poissonArrivals(sixtySeconds)).toEqual(poissonArrivals(sixtySeconds));
    expect(poissonArrivals({ ...sixtySeconds, seed: 43 })).not.toEqual(poissonArrivals(sixtySeconds));
  });
});
