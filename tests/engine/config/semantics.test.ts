import { describe, expect, it } from 'vitest';
import { backoffDelayMs, carriedDeadlineMs, localWorkMaxMs, localWorkMs } from '../../../src/engine/config/semantics';
import { service } from '../../helpers/fixtures';

describe('config semantics shared by the analyzer and the simulator', () => {
  it('computes backoff delays as min(base × multiplier^(retry − 1), max)', () => {
    // Plan: take a backoff of 10 ms, ×2, capped at 30 ms, for retries 1 to 4.
    // Verifies: the delays are 10, 20, 30 (capped) and 30 ms.
    const backoff = { baseMs: 10, multiplier: 2, maxMs: 30, jitter: 'full' as const };
    expect([1, 2, 3, 4].map((retry) => backoffDelayMs(backoff, retry))).toEqual([10, 20, 30, 30]);
  });

  it('keeps local work within serviceTime × [1 − jitter, 1 + jitter], scaled by a fault', () => {
    // Plan: a 10 ms service with jitter 0.5, at draws 0, 0.5 and just below 1, healthy and under a ×5 fault.
    // Verifies: 5, 10 and almost 15 ms when healthy, five times that under the fault, and 15 ms as the maximum.
    const s = service({ serviceTimeMs: 10, serviceTimeJitter: 0.5 });
    expect(localWorkMs(s, 0)).toBe(5);
    expect(localWorkMs(s, 0.5)).toBe(10);
    expect(localWorkMs(s, 0.999999)).toBeLessThan(localWorkMaxMs(s));
    expect(localWorkMs(s, 0.5, 5)).toBe(50);
    expect(localWorkMaxMs(s)).toBe(15);
  });

  it('carries a deadline that leaves the callee exactly timeout − rtt', () => {
    // Plan: an attempt sent at t = 100 with a 150 ms timeout over 1 ms links.
    // Verifies: the callee must finish by 249; arriving at 101, it has 148 ms, the budget math's window.
    const deadline = carriedDeadlineMs(100, 150, 1);
    expect(deadline).toBe(249);
    expect(deadline - (100 + 1)).toBe(150 - 2);
  });
});
