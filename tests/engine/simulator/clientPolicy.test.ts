import { describe, expect, it } from 'vitest';
import { afterFailure, attemptTimeout } from '../../../src/engine/simulator/clientPolicy';
import { call } from '../../helpers/fixtures';

const state = { attempt: 1, remainingMs: Infinity, tokens: Infinity, draw: 0.5 };

describe('attemptTimeout', () => {
  it('uses the configured timeout, cut to the time left', () => {
    // Plan: a 150 ms timeout with no deadline, then with 80 ms left.
    // Verifies: 150 ms, then 80 ms.
    const c = call('c', 'x', { timeoutMs: 150 });
    expect(attemptTimeout(c, state)).toBe(150);
    expect(attemptTimeout(c, { ...state, remainingMs: 80 })).toBe(80);
  });
});

describe('afterFailure', () => {
  const retrying = call('c', 'x', { maxAttempts: 3 });

  it('retries while attempts, time and tokens remain', () => {
    // Plan: fail attempt 1 of 3 with no deadline and no budget.
    // Verifies: a retry, immediately, since there is no backoff.
    expect(afterFailure(retrying, state)).toEqual({ retry: true, delayMs: 0 });
  });

  it.each([
    ['after the last attempt', { attempt: 3 }],
    ['when the deadline has passed', { remainingMs: 0 }],
    ['without a retry-budget token', { tokens: 0.5 }],
  ])('refuses to retry %s', (_name, change) => {
    // Plan: fail an attempt in each refusing situation.
    // Verifies: no retry.
    expect(afterFailure(retrying, { ...state, ...change })).toEqual({ retry: false });
  });

  it('counts a token that floating point leaves a hair below 1 as a whole token', () => {
    // Plan: ten first attempts earning 0.1 each add up to 0.9999999999999999 in floating point.
    // Verifies: that still allows a retry.
    let tokens = 0;
    for (let i = 0; i < 10; i++) tokens += 0.1;
    expect(tokens).toBeLessThan(1);
    expect(afterFailure(retrying, { ...state, tokens }).retry).toBe(true);
  });

  it('does not wait for a retry whose backoff would end at or after the deadline', () => {
    // Plan: a 20 ms backoff before retry 1, with 21 ms and then exactly 20 ms left; then full jitter with
    //   15 ms left and draws of 0.5 (a 10 ms wait) and 0.9 (18 ms).
    // Verifies: it retries only when the wait ends before the deadline, so no worker is held for a retry
    //   that could never be sent.
    const plain = call('c', 'x', { maxAttempts: 3, backoff: { baseMs: 20, multiplier: 2, maxMs: 100, jitter: 'none' } });
    const jittered = call('c', 'x', { maxAttempts: 3, backoff: { baseMs: 20, multiplier: 2, maxMs: 100, jitter: 'full' } });
    expect(afterFailure(plain, { ...state, remainingMs: 21 })).toEqual({ retry: true, delayMs: 20 });
    expect(afterFailure(plain, { ...state, remainingMs: 20 })).toEqual({ retry: false });
    expect(afterFailure(jittered, { ...state, remainingMs: 15, draw: 0.5 })).toEqual({ retry: true, delayMs: 10 });
    expect(afterFailure(jittered, { ...state, remainingMs: 15, draw: 0.9 })).toEqual({ retry: false });
  });

  it('waits the backoff delay, scaled by the draw with full jitter', () => {
    // Plan: fail attempt 2 with a backoff of 10 ms × 2 (so 20 ms before retry 2), without and with jitter.
    // Verifies: exactly 20 ms without jitter; 20 × 0.5 = 10 ms with full jitter and a draw of 0.5.
    const backoff = { baseMs: 10, multiplier: 2, maxMs: 100 };
    const plain = call('c', 'x', { maxAttempts: 3, backoff: { ...backoff, jitter: 'none' } });
    const jittered = call('c', 'x', { maxAttempts: 3, backoff: { ...backoff, jitter: 'full' } });
    expect(afterFailure(plain, { ...state, attempt: 2 })).toEqual({ retry: true, delayMs: 20 });
    expect(afterFailure(jittered, { ...state, attempt: 2 })).toEqual({ retry: true, delayMs: 10 });
  });
});
