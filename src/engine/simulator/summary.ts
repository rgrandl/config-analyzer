// The numbers for the summary cards (DESIGN.md §10), computed from one run's outcomes.
import type { Ms, Scenario, SystemConfig } from '../config/schema';
import { ArrivalWindows, computeRecovery, lowestWindowRatio, type Recovery } from './recovery';
import type { RunResult } from './types';

/** A value measured before, during and after the faults; during and after are null without faults. */
export interface Phases {
  readonly before: number | null;
  readonly during: number | null;
  readonly after: number | null;
}

export interface RunSummary {
  /** Share of requests that succeeded within their deadline, by the window they arrived in. */
  readonly successRatio: Phases;
  /** Successes within the deadline per second, by completion time. */
  readonly goodputPerSec: Phases;
  readonly recovery: Recovery;
  /** Lowest success ratio of any recovery-length window after warm-up: how far a run dips at its worst. */
  readonly lowestWindowRatio: number | null;
  readonly attempts: number;
  readonly timeouts: number;
  /** timeouts ÷ attempts; in a run without faults, these are false timeouts. */
  readonly timeoutFraction: number;
  /**
   * Per service: worker time spent on abandoned work ÷ its busy worker time, over the whole run. Per service
   * because an average across services is dominated by callers that hold workers while they wait.
   */
  readonly wastedFraction: Readonly<Record<string, number>>;
  readonly truncated: boolean;
}

export function summarizeRun(result: RunResult, system: SystemConfig, scenario: Scenario): RunSummary {
  const deadlineMs = system.entry.deadlineMs;
  const phases = phaseBounds(scenario, result.endedAtMs);
  const windows = ArrivalWindows.of(result, deadlineMs);
  const ratio = (range: readonly [Ms, Ms] | null) => (range ? windows.ratio(range[0], range[1]) : null);

  let attempts = 0;
  let timeouts = 0;
  const busyMs = new Map<string, number>();
  const wastedMs = new Map<string, number>();
  for (const bucket of result.buckets) {
    const lengthMs = Math.min(scenario.bucketMs, scenario.durationMs - bucket.startMs);
    for (const call of Object.values(bucket.calls)) {
      attempts += call.attempts;
      timeouts += call.timeouts;
    }
    for (const [name, service] of Object.entries(bucket.services)) {
      const busy = service.utilization * (system.services[name]?.workers ?? 0) * lengthMs;
      busyMs.set(name, (busyMs.get(name) ?? 0) + busy);
      wastedMs.set(name, (wastedMs.get(name) ?? 0) + busy * service.wastedFraction);
    }
  }

  return {
    successRatio: { before: ratio(phases.before), during: ratio(phases.during), after: ratio(phases.after) },
    goodputPerSec: {
      before: goodputPerSec(result, phases.before),
      during: goodputPerSec(result, phases.during),
      after: goodputPerSec(result, phases.after),
    },
    recovery: computeRecovery(windows, scenario, result.truncated),
    lowestWindowRatio: lowestWindowRatio(windows, scenario.warmupMs, scenario.recovery.windowMs),
    attempts,
    timeouts,
    timeoutFraction: attempts > 0 ? timeouts / attempts : 0,
    wastedFraction: Object.fromEntries(
      [...busyMs].map(([name, busy]) => [name, busy > 0 ? (wastedMs.get(name) ?? 0) / busy : 0]),
    ),
    truncated: result.truncated,
  };
}

/** [warm-up, first fault), [first fault, last fault end), [last fault end, end of run). */
function phaseBounds(scenario: Scenario, endedAtMs: Ms) {
  if (scenario.faults.length === 0) {
    return { before: [scenario.warmupMs, endedAtMs] as const, during: null, after: null };
  }
  const start = Math.min(...scenario.faults.map((fault) => fault.startMs));
  const end = Math.max(...scenario.faults.map((fault) => fault.endMs));
  return {
    before: [scenario.warmupMs, start] as const,
    during: [start, end] as const,
    after: [end, endedAtMs] as const,
  };
}

function goodputPerSec(result: RunResult, range: readonly [Ms, Ms] | null): number | null {
  if (!range || range[1] <= range[0]) return null;
  const count = result.buckets
    .filter((bucket) => bucket.startMs >= range[0] && bucket.startMs < range[1])
    .reduce((sum, bucket) => sum + bucket.goodput, 0);
  return count / ((range[1] - range[0]) / 1000);
}
