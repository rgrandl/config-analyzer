// Budget math (DESIGN.md §6): how much time each service and call has, and how much it may need.
// Latencies and throughput are computed bottom-up (callees first); budgets and shares top-down (callers first).
// All values are in milliseconds, and throughput is in requests per millisecond.
import { CallGraph, type CallEdge, type CallId } from '../config/callGraph';
import { backoffDelayMs, localWorkMaxMs } from '../config/semantics';
import {
  DEFAULT_ANALYZER_OPTIONS,
  type AnalyzerOptions,
  type BackoffConfig,
  type CallConfig,
  type Ms,
  type ServiceConfig,
  type SystemConfig,
} from '../config/schema';
import { DEFAULT_BACKOFF } from './defaults';

/** Where a service's budget comes from, for explanations. */
export type BudgetSource =
  /** The entry: the user's deadline, minus the round trip. */
  | { readonly kind: 'deadline'; readonly deadlineMs: Ms }
  /**
   * The tightest call into the service: its timeout, or the caller's share when that is smaller, minus the
   * round trip. `limitMs` is that timeout or share.
   */
  | {
      readonly kind: 'call';
      readonly caller: string;
      readonly call: string;
      readonly limitedBy: 'timeout' | 'share';
      readonly limitMs: Ms;
    };

/** What caps a service's throughput, for explanations. */
export type ThroughputLimit =
  /** Its own workers. */
  | { readonly kind: 'workers' }
  /**
   * A service below it, whose workers cap it: `bottleneck` completes `bottleneckPerMs` requests per ms, and each
   * request of this service makes `callsPerRequest` calls to it (through intermediate services if any).
   */
  | { readonly kind: 'downstream'; readonly bottleneck: string; readonly callsPerRequest: number; readonly bottleneckPerMs: number };

export interface ServiceBudget {
  /** Worst-case local work: serviceTimeMs × (1 + jitter). */
  readonly svcMaxMs: Ms;
  /** Worst-case latency with no queueing and no faults, including all downstream calls. */
  readonly healthyMs: Ms;
  /** Mean latency with no queueing and no faults; used for capacity. */
  readonly meanHealthyMs: Ms;
  /** Requests per ms this service can complete, limited by its workers and by its callees. */
  readonly throughputPerMs: number;
  readonly throughputLimit: ThroughputLimit;
  /** Time this service really has for a request; 0 when there is none left. */
  readonly budgetMs: Ms;
  readonly budgetSource: BudgetSource;
  /** Time left for downstream calls after worst-case local work: budget − svcMax. At most 0 means none. */
  readonly availableMs: Ms;
  /** Worst-case time a request can wait in a full queue; Infinity for unbounded queues. */
  readonly maxQueueWaitMs: Ms;
}

export interface CallBudget {
  /** Round trip plus the callee's healthy latency. */
  readonly healthyMs: Ms;
  /** Lowest timeout a mitigation may set. */
  readonly floorMs: Ms;
  /** Worst case of all configured attempts, including the effective backoff. */
  readonly worstCaseMs: Ms;
  /** Worst-case time spent before this call starts: local work plus earlier calls. */
  readonly elapsedBeforeMs: Ms;
  /** Time held back for later calls: the sum of their floors. */
  readonly reserveMs: Ms;
  /** Time this call may use. Negative when earlier work already exceeds the budget. */
  readonly shareMs: Ms;
  /** Time the callee has for this call: min(timeout, share) − rtt, at least 0. */
  readonly windowMs: Ms;
}

/** Budgets for every service and call of one system config. */
export class Budgets {
  constructor(
    readonly rttMs: Ms,
    private readonly services: ReadonlyMap<string, ServiceBudget>,
    private readonly calls: ReadonlyMap<CallId, CallBudget>,
  ) {}

  service(name: string): ServiceBudget {
    return required(this.services.get(name), `service "${name}"`);
  }

  call(id: CallId): CallBudget {
    return required(this.calls.get(id), `call "${id}"`);
  }
}

/**
 * The backoff a call will have after mitigation: its own, or DEFAULT_BACKOFF when it retries without
 * one. A backoff with baseMs 0 gets the default base delay, and maxMs is raised to at least that, so the
 * result stays valid (maxMs ≥ baseMs). Calls with a single attempt never back off, so they keep what they have.
 * Rule 3 must patch exactly this; see DESIGN.md §7.
 */
export function effectiveBackoff(call: CallConfig): BackoffConfig | undefined {
  if (call.maxAttempts <= 1) return call.backoff;
  if (!call.backoff) return DEFAULT_BACKOFF;
  if (call.backoff.baseMs === 0) {
    return {
      ...call.backoff,
      baseMs: DEFAULT_BACKOFF.baseMs,
      maxMs: Math.max(call.backoff.maxMs, DEFAULT_BACKOFF.baseMs),
    };
  }
  return call.backoff;
}

/** Worst case of `attempts` attempts of `timeoutMs` each, plus the effective backoff before each retry. */
export function worstCaseMs(call: CallConfig, attempts: number, timeoutMs: Ms): Ms {
  const backoff = effectiveBackoff(call);
  let total = attempts * timeoutMs;
  if (backoff) {
    for (let retry = 1; retry < attempts; retry++) total += backoffDelayMs(backoff, retry);
  }
  return total;
}

/**
 * Budgets for a validated system config: callers must exist for every service except the entry, and the
 * graph must be acyclic. `graph` can be passed when the caller already built one.
 */
export function computeBudgets(
  system: SystemConfig,
  options: AnalyzerOptions = DEFAULT_ANALYZER_OPTIONS,
  graph: CallGraph = new CallGraph(system.services),
): Budgets {
  const rttMs = 2 * system.networkLatencyMs;
  const order = graph.topologicalOrder();
  const latencies = computeLatencies(system, graph, order, rttMs);

  const services = new Map<string, ServiceBudget>();
  const calls = new Map<CallId, CallBudget>();
  for (const name of order) {
    const config = serviceConfig(system, name);
    const latency = required(latencies.get(name), `latency of "${name}"`);

    const { budgetMs: rawBudgetMs, budgetSource } = serviceBudget(system, graph, name, calls, rttMs);
    const budgetMs = Math.max(0, rawBudgetMs);
    const maxQueueWaitMs =
      config.queueCapacity === 'unbounded' ? Infinity : config.queueCapacity / latency.throughputPerMs;
    services.set(name, { ...latency, budgetMs, budgetSource, availableMs: budgetMs - latency.svcMaxMs, maxQueueWaitMs });

    const health = graph.callsOf(name).map((edge) => callHealth(system, edge, latencies, rttMs, options));
    allocateCalls(graph.callsOf(name), health, budgetMs, latency.svcMaxMs, rttMs).forEach((budget, id) =>
      calls.set(id, budget),
    );
  }
  return new Budgets(rttMs, services, calls);
}

/** The entry has the user's deadline; every other service has the tightest window its callers give it. */
function serviceBudget(
  system: SystemConfig,
  graph: CallGraph,
  name: string,
  calls: ReadonlyMap<CallId, CallBudget>,
  rttMs: Ms,
): { budgetMs: Ms; budgetSource: BudgetSource } {
  if (name === system.entry.service) {
    return { budgetMs: system.entry.deadlineMs - rttMs, budgetSource: { kind: 'deadline', deadlineMs: system.entry.deadlineMs } };
  }
  const callers = graph.callersOf(name);
  if (callers.length === 0) throw new Error(`Service "${name}" has no callers; validate the config first`);
  // The first of the tightest calls, in graph order, names the source.
  let tightest: { edge: CallEdge; call: CallBudget } | undefined;
  for (const edge of callers) {
    const call = required(calls.get(edge.id), edge.id);
    if (!tightest || call.windowMs < tightest.call.windowMs) tightest = { edge, call };
  }
  const { edge, call } = required(tightest, name);
  const limitedBy = call.shareMs < edge.config.timeoutMs ? 'share' : 'timeout';
  return {
    budgetMs: call.windowMs,
    budgetSource: {
      kind: 'call',
      caller: edge.caller,
      call: edge.config.name,
      limitedBy,
      limitMs: limitedBy === 'share' ? call.shareMs : edge.config.timeoutMs,
    },
  };
}

type Latency = Pick<ServiceBudget, 'svcMaxMs' | 'healthyMs' | 'meanHealthyMs' | 'throughputPerMs' | 'throughputLimit'>;

/** Bottom-up: a service's latency and throughput depend only on its own settings and its callees'. */
function computeLatencies(
  system: SystemConfig,
  graph: CallGraph,
  order: readonly string[],
  rttMs: Ms,
): Map<string, Latency> {
  const latencies = new Map<string, Latency>();
  for (const name of [...order].reverse()) {
    const config = serviceConfig(system, name);
    const callees = graph.callsOf(name).map((edge) => required(latencies.get(edge.callee), edge.callee));

    const svcMaxMs = localWorkMaxMs(config);
    const healthyMs = svcMaxMs + sum(callees.map((callee) => rttMs + callee.healthyMs));
    const meanHealthyMs = config.serviceTimeMs + sum(callees.map((callee) => rttMs + callee.meanHealthyMs));

    // A job that calls C k times can complete at most throughput(C) / k times per ms. On a tie, the service's
    // own workers are named as the limit.
    let throughputPerMs = config.workers / meanHealthyMs;
    let throughputLimit: ThroughputLimit = { kind: 'workers' };
    for (const [callee, count] of countBy(graph.callsOf(name).map((edge) => edge.callee))) {
      const below = required(latencies.get(callee), callee);
      if (below.throughputPerMs / count >= throughputPerMs) continue;
      throughputPerMs = below.throughputPerMs / count;
      throughputLimit =
        below.throughputLimit.kind === 'workers'
          ? { kind: 'downstream', bottleneck: callee, callsPerRequest: count, bottleneckPerMs: below.throughputPerMs }
          : { ...below.throughputLimit, callsPerRequest: count * below.throughputLimit.callsPerRequest };
    }
    latencies.set(name, { svcMaxMs, healthyMs, meanHealthyMs, throughputPerMs, throughputLimit });
  }
  return latencies;
}

/** A call's healthy latency, and the floor: the timeout floor multiplier × the larger of healthy and observed p99. */
function callHealth(
  system: SystemConfig,
  edge: CallEdge,
  latencies: ReadonlyMap<string, Latency>,
  rttMs: Ms,
  options: AnalyzerOptions,
): { healthyMs: Ms; floorMs: Ms } {
  const healthyMs = rttMs + required(latencies.get(edge.callee), edge.callee).healthyMs;
  const observedP99Ms = serviceConfig(system, edge.callee).observedP99Ms;
  const observedMs = observedP99Ms === undefined ? 0 : rttMs + observedP99Ms;
  return { healthyMs, floorMs: options.timeoutFloorMultiplier * Math.max(healthyMs, observedMs) };
}

/**
 * Order-aware allocation of a service's budget to its sequential calls (DESIGN.md §6).
 * Each call may use what is left after the worst case of everything before it, minus the floors of
 * the calls after it. Earlier calls count at min(worstCase, max(0, share)): an overrunning call has its
 * own finding, and later calls are evaluated as if it were fixed; a negative share never gives time back.
 * A consequence: bringing an earlier call within its share can only grow the shares of later calls.
 */
function allocateCalls(
  calls: readonly CallEdge[],
  health: readonly { healthyMs: Ms; floorMs: Ms }[],
  budgetMs: Ms,
  svcMaxMs: Ms,
  rttMs: Ms,
): Map<CallId, CallBudget> {
  const budgets = new Map<CallId, CallBudget>();
  let elapsedBeforeMs = svcMaxMs;
  calls.forEach((edge, index) => {
    const { healthyMs, floorMs } = required(health[index], edge.id);
    const reserveMs = sum(health.slice(index + 1).map((later) => later.floorMs));
    const shareMs = budgetMs - elapsedBeforeMs - reserveMs;
    const worstMs = worstCaseMs(edge.config, edge.config.maxAttempts, edge.config.timeoutMs);
    const windowMs = Math.max(0, Math.min(edge.config.timeoutMs, shareMs) - rttMs);

    budgets.set(edge.id, { healthyMs, floorMs, worstCaseMs: worstMs, elapsedBeforeMs, reserveMs, shareMs, windowMs });
    elapsedBeforeMs += Math.min(worstMs, Math.max(0, shareMs));
  });
  return budgets;
}

function serviceConfig(system: SystemConfig, name: string): ServiceConfig {
  return required(system.services[name], `service "${name}"`);
}

/** Unwraps a value that the graph's structure guarantees to exist; a miss is a programming error. */
function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`Missing ${what}`);
  return value;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function countBy(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}
