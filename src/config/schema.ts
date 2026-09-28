// Schema of the two input documents (DESIGN.md §5).
// The system config is read by the analyzer and the simulator; the scenario only by the simulator.

/** Milliseconds. */
export type Ms = number;

// ---------------------------------------------------------------------------
// System config
// ---------------------------------------------------------------------------

export interface SystemConfig {
  version: 1;
  /** One-way network latency per hop. A round trip (rtt) is twice this. */
  networkLatencyMs: Ms;
  /** The end user calls `service` and gives up after `deadlineMs`. Never patched. */
  entry: EntryConfig;
  /** Services by name. */
  services: Record<string, ServiceConfig>;
}

export interface EntryConfig {
  service: string;
  deadlineMs: Ms;
}

export interface ServiceConfig {
  /** Thread-per-request concurrency: a request holds one worker for its whole life. */
  workers: number;
  /** FIFO queue in front of the workers. A full queue rejects immediately. */
  queueCapacity: number | 'unbounded';
  /** Mean local work per request. */
  serviceTimeMs: Ms;
  /** Local work is uniform in serviceTimeMs × [1 − jitter, 1 + jitter]; 0..0.9. */
  serviceTimeJitter: number;
  /** Optional real-world latency; raises the timeout floor of calls into this service. */
  observedP99Ms?: Ms;
  /** Honor the incoming deadline (drop expired work) and pass it on to downstream calls. */
  deadlinePropagation: boolean;
  /** Downstream calls, executed sequentially in this order. */
  calls: CallConfig[];
}

export interface CallConfig {
  /** Unique within the calling service. The call id is "<service>.<name>", e.g. "orders.readStock". */
  name: string;
  /** Name of the callee service. */
  to: string;
  /** Per attempt; covers the network round trip. */
  timeoutMs: Ms;
  /** Integer ≥ 1, including the first try. */
  maxAttempts: number;
  backoff?: BackoffConfig;
  retryBudget?: RetryBudgetConfig;
}

export interface BackoffConfig {
  baseMs: Ms;
  multiplier: number;
  maxMs: Ms;
  jitter: 'none' | 'full';
}

/** Token bucket per call: each first attempt earns `ratio` tokens, each retry spends 1. Starts full. */
export interface RetryBudgetConfig {
  ratio: number;
  maxTokens: number;
}

// ---------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------

export interface Scenario {
  version: 1;
  /** Poisson arrival rate of end-user requests, per second. */
  rps: number;
  durationMs: Ms;
  /** Excluded from the recovery baseline. */
  warmupMs: Ms;
  /** Metric bucket size (default 250). */
  bucketMs: Ms;
  seed: number;
  faults: Fault[];
  recovery: RecoveryConfig;
}

export interface Fault {
  service: string;
  startMs: Ms;
  endMs: Ms;
  /** Multiplies local work while active (default 1). */
  latencyMultiplier?: number;
  /** Probability that a job fails after its local work while active (default 0). */
  errorRate?: number;
}

export interface RecoveryConfig {
  /** Recovered when the success ratio stays ≥ this percentage of the baseline... */
  thresholdPct: number;
  /** ...measured over windows of this length... */
  windowMs: Ms;
  /** ...continuously for this long. */
  holdMs: Ms;
}

// ---------------------------------------------------------------------------
// Analyzer options
// ---------------------------------------------------------------------------

export interface AnalyzerOptions {
  /** A mitigation never sets a timeout below this multiple of the callee's healthy latency. */
  timeoutFloorMultiplier: number;
}

export const DEFAULT_ANALYZER_OPTIONS: AnalyzerOptions = {
  timeoutFloorMultiplier: 2,
};
