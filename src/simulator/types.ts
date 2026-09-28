// Simulator contracts (DESIGN.md §9, §10).
// RunResult carries outcomes only, so a different backend (e.g. real services) could produce it too.

import type { CallConfig, Ms, Scenario, SystemConfig } from '../config/schema';

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/** Produces sorted end-user arrival timestamps. Called once and shared by all runs of a comparison. */
export type ArrivalSource = (scenario: Scenario) => Ms[];

/** Anything that can execute a scenario against a system config. */
export interface Runner {
  run(system: SystemConfig, scenario: Scenario, arrivals: Ms[]): RunResult;
}

/** What the client policy knows when it decides about one attempt. */
export interface AttemptState {
  /** 1-based. */
  attempt: number;
  /** Time left until the caller's deadline; Infinity if the caller does not propagate deadlines. */
  remainingMs: Ms;
  /** Retry-budget tokens currently available; Infinity if the call has no budget. */
  tokens: number;
  /** Keyed random draw in (0, 1), used for backoff jitter. */
  draw: number;
}

/** How long may this attempt take? */
export type AttemptTimeout = (call: CallConfig, state: AttemptState) => Ms;

/** After a failed attempt: retry, and after what delay? */
export type AfterFailure = (
  call: CallConfig,
  state: AttemptState,
) => { retry: false } | { retry: true; delayMs: Ms };

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface RunResult {
  /** One entry per `bucketMs`, from t = 0. */
  buckets: BucketMetrics[];
  /** Every end-user request, in arrival order. Recovery is computed from these. */
  requests: RequestOutcome[];
}

export interface RequestOutcome {
  arrivalMs: Ms;
  /** When the response reached the user; null if the run ended first. */
  completionMs: Ms | null;
  /** Succeeded within the user's deadline. */
  ok: boolean;
}

export interface BucketMetrics {
  startMs: Ms;
  userArrivals: number;
  /** Successes within the user deadline, by completion time. */
  goodput: number;
  /** Successes after the user had already given up. */
  lateSuccesses: number;
  failures: number;
  services: Record<string, ServiceBucketMetrics>;
  /** Keyed by call id, e.g. "orders.readStock". */
  calls: Record<string, CallBucketMetrics>;
}

export interface ServiceBucketMetrics {
  firstAttemptArrivals: number;
  retryArrivals: number;
  rejections: number;
  expiredDrops: number;
  maxQueueDepth: number;
  /** Busy worker time ÷ (workers × bucketMs), 0..1. */
  utilization: number;
  /** Worker time spent on jobs whose caller had given up ÷ busy worker time, 0..1. */
  wastedFraction: number;
}

export interface CallBucketMetrics {
  attempts: number;
  retries: number;
  timeouts: number;
  failures: number;
}
