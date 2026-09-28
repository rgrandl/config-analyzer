// Recovery after a fault (DESIGN.md §10.2), computed from request outcomes rather than buckets, so the
// answer does not depend on bucketMs. A request counts for the window it arrived in, and succeeded if it
// was answered within its deadline; judging by arrival removes the noise of the arrival process itself.
import type { Ms, Scenario } from '../config/schema';
import { RECOVERY_GRID_MS } from '../config/semantics';
import type { RequestOutcome, RunResult } from './types';

/** Ratios are compared with this tolerance, so a window exactly at the threshold counts as meeting it. */
const RATIO_TOLERANCE = 1e-12;

/**
 * - recovered: every window stayed at or above the threshold for the hold period, starting at recoveredAtMs;
 * - not-recovered: no such period before the last known outcome;
 * - unknown: the run was truncated before recovery could be confirmed either way;
 * - not-applicable: no faults, or a baseline of 0 (nothing to recover to).
 */
export type RecoveryStatus = 'recovered' | 'not-recovered' | 'unknown' | 'not-applicable';

export interface Recovery {
  readonly status: RecoveryStatus;
  /** Success ratio of requests arriving between warm-up and the first fault (or the end, without faults). */
  readonly baselineRatio: number | null;
  /** Recovered once every window stays at or above this ratio for the hold period. */
  readonly thresholdRatio: number | null;
  readonly recoveredAtMs: Ms | null;
  /** recoveredAtMs − the end of the last fault. */
  readonly recoveryTimeMs: Ms | null;
}

/** Success ratios over arrival windows, answered in O(log n) from prefix counts. */
export class ArrivalWindows {
  private readonly arrivals: Ms[];
  private readonly okBefore: number[];

  /**
   * `requests` must be in arrival order. Requests arriving at or after `lastUsableMs` are ignored: the run
   * ended before they could reach their deadline, so their outcome is unknown.
   */
  constructor(requests: readonly RequestOutcome[], readonly lastUsableMs: Ms) {
    const usable = requests.filter((request) => request.arrivalMs < lastUsableMs);
    this.arrivals = usable.map((request) => request.arrivalMs);
    this.okBefore = [0];
    for (const request of usable) this.okBefore.push((this.okBefore.at(-1) ?? 0) + (request.ok ? 1 : 0));
  }

  /** The windows of a run: outcomes are known for arrivals up to the run's end minus the user deadline. */
  static of(result: RunResult, deadlineMs: Ms): ArrivalWindows {
    return new ArrivalWindows(result.requests, result.endedAtMs - deadlineMs);
  }

  /** Share of requests arriving in [fromMs, toMs) that succeeded; null when none arrived there. */
  ratio(fromMs: Ms, toMs: Ms): number | null {
    const first = this.lowerBound(fromMs);
    const last = this.lowerBound(Math.min(toMs, this.lastUsableMs));
    const count = last - first;
    if (count <= 0) return null;
    return ((this.okBefore[last] ?? 0) - (this.okBefore[first] ?? 0)) / count;
  }

  /** Index of the first arrival at or after `time`. */
  private lowerBound(time: Ms): number {
    let low = 0;
    let high = this.arrivals.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((this.arrivals[middle] ?? Infinity) < time) low = middle + 1;
      else high = middle;
    }
    return low;
  }
}

export function computeRecovery(
  windows: ArrivalWindows,
  scenario: Scenario,
  truncated: boolean,
): Recovery {
  const hasFaults = scenario.faults.length > 0;
  const firstFaultStart = hasFaults ? Math.min(...scenario.faults.map((fault) => fault.startMs)) : windows.lastUsableMs;
  const baselineRatio = windows.ratio(scenario.warmupMs, firstFaultStart);
  const thresholdRatio = baselineRatio === null ? null : (baselineRatio * scenario.recovery.thresholdPct) / 100;
  const outcome = (status: RecoveryStatus, recoveredAtMs: Ms | null = null, recoveryTimeMs: Ms | null = null) => ({
    status,
    baselineRatio,
    thresholdRatio,
    recoveredAtMs,
    recoveryTimeMs,
  });

  // Without faults there is nothing to recover from; with a baseline of 0, nothing to recover to.
  if (!hasFaults || baselineRatio === null || baselineRatio === 0 || thresholdRatio === null) {
    return outcome('not-applicable');
  }

  const faultEnd = Math.max(...scenario.faults.map((fault) => fault.endMs));
  const { windowMs, holdMs } = scenario.recovery;
  const firstCandidate = Math.ceil(faultEnd / RECOVERY_GRID_MS) * RECOVERY_GRID_MS;
  for (let t = firstCandidate; t + holdMs <= windows.lastUsableMs; t += RECOVERY_GRID_MS) {
    if (holds(windows, t, holdMs, windowMs, thresholdRatio)) return outcome('recovered', t, t - faultEnd);
  }
  return outcome(truncated ? 'unknown' : 'not-recovered');
}

/**
 * Every window in the hold [t, t + holdMs] is at or above the threshold: windows start on the grid, plus one
 * ending exactly at t + holdMs, so no part of the hold goes unchecked. Windows with no arrivals are skipped;
 * at least one window must have arrivals, so a period of silence never counts as recovered.
 */
function holds(windows: ArrivalWindows, t: Ms, holdMs: Ms, windowMs: Ms, thresholdRatio: number): boolean {
  const lastStart = t + holdMs - windowMs;
  const starts: Ms[] = [];
  for (let start = t; start < lastStart; start += RECOVERY_GRID_MS) starts.push(start);
  starts.push(lastStart);

  let measured = 0;
  for (const start of starts) {
    const ratio = windows.ratio(start, start + windowMs);
    if (ratio === null) continue;
    if (ratio < thresholdRatio - RATIO_TOLERANCE) return false;
    measured++;
  }
  return measured > 0;
}

/** Lowest success ratio of any window of `windowMs` from `fromMs` on, on the grid; null when none has arrivals. */
export function lowestWindowRatio(windows: ArrivalWindows, fromMs: Ms, windowMs: Ms): number | null {
  let lowest: number | null = null;
  for (let start = fromMs; start + windowMs <= windows.lastUsableMs; start += RECOVERY_GRID_MS) {
    const ratio = windows.ratio(start, start + windowMs);
    if (ratio !== null && (lowest === null || ratio < lowest)) lowest = ratio;
  }
  return lowest;
}
