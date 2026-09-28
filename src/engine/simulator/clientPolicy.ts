// Per-attempt client decisions (DESIGN.md §9.2): how long an attempt may take, and whether and when to retry.
// Pure functions of the call's config and what the caller knows, so they can be tested on their own and
// extended later (circuit breakers, hedging) without touching the event loop.
import type { BackoffConfig } from '../config/schema';
import { backoffDelayMs } from '../config/semantics';
import type { AfterFailure, AttemptTimeout } from './types';

/** Tokens accumulate in steps such as 0.1, which floating point does not add up exactly (10 × 0.1 < 1). */
const TOKEN_TOLERANCE = 1e-9;

/** The configured timeout, cut to the time left when the caller propagates deadlines (otherwise remainingMs is ∞). */
export const attemptTimeout: AttemptTimeout = (call, state) => Math.min(call.timeoutMs, state.remainingMs);

/**
 * Retry only while attempts remain, a retry-budget token is available, and the retry can start before the
 * caller's deadline: a backoff that ends at or after it would only keep a worker busy for a retry that
 * cannot happen. The delay is the backoff for this retry: exact without jitter, uniform in [0, delay) with
 * full jitter, and 0 without a backoff.
 */
export const afterFailure: AfterFailure = (call, state) => {
  if (state.attempt >= call.maxAttempts || state.tokens < 1 - TOKEN_TOLERANCE) return { retry: false };
  const delayMs = backoffDelay(call.backoff, state.attempt, state.draw);
  if (delayMs >= state.remainingMs) return { retry: false };
  return { retry: true, delayMs };
};

function backoffDelay(backoff: BackoffConfig | undefined, retry: number, draw: number): number {
  if (!backoff) return 0;
  const delayMs = backoffDelayMs(backoff, retry);
  return backoff.jitter === 'full' ? delayMs * draw : delayMs;
}
