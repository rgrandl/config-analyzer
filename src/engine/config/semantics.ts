// Semantics of a config that the analyzer and the simulator must agree on (DESIGN.md §9.1 contracts).
// Both import these functions, so a contract cannot drift between the budget math and the event loop.
import type { BackoffConfig, Ms, ServiceConfig } from './schema';

/**
 * Delay before retry `retry` (1-based), before jitter: min(baseMs × multiplier^(retry−1), maxMs).
 * With full jitter the actual delay is uniform in [0, this], so this is also its upper bound.
 */
export function backoffDelayMs(backoff: BackoffConfig, retry: number): Ms {
  return Math.min(backoff.baseMs * backoff.multiplier ** (retry - 1), backoff.maxMs);
}

/**
 * Duration of one job's local work: serviceTimeMs × (1 − jitter + 2·jitter·u) × multiplier, where u in [0, 1)
 * is a random draw and multiplier comes from an active fault (1 otherwise). Uniform in
 * serviceTimeMs × [1 − jitter, 1 + jitter] when healthy.
 */
export function localWorkMs(service: ServiceConfig, u: number, multiplier = 1): Ms {
  const jitter = service.serviceTimeJitter;
  return service.serviceTimeMs * (1 - jitter + 2 * jitter * u) * multiplier;
}

/** Upper bound of healthy local work: serviceTimeMs × (1 + jitter). The budget math calls it svcMax. */
export function localWorkMaxMs(service: ServiceConfig): Ms {
  return service.serviceTimeMs * (1 + service.serviceTimeJitter);
}

/**
 * The deadline a request carries to its callee: the caller gives up at sentAt + attemptTimeout, and the
 * response needs one network hop to get back, so the callee must be done by sentAt + attemptTimeout − latency.
 * Arriving one hop after sentAt, the callee therefore has attemptTimeout − rtt: the budget math's window.
 */
export function carriedDeadlineMs(sentAtMs: Ms, attemptTimeoutMs: Ms, networkLatencyMs: Ms): Ms {
  return sentAtMs + attemptTimeoutMs - networkLatencyMs;
}
