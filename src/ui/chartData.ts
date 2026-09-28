// Turns run results into chart rows: one row per time step, with the original and mitigated values side by side.
import type { Ms } from '../engine/config/schema';
import type { SummarizedRun } from '../engine/simulator/compare';
import { ArrivalWindows } from '../engine/simulator/recovery';
import type { BucketMetrics, RunResult } from '../engine/simulator/types';

export interface ChartRow {
  /** Seconds since the start of the run. */
  readonly t: number;
  readonly original: number | null;
  readonly mitigated: number | null;
}

/** A per-bucket value, from each run's buckets; null where a bucket is missing. */
function paired(original: RunResult, mitigated: RunResult, value: (bucket: BucketMetrics) => number | null): ChartRow[] {
  return original.buckets.map((bucket, index) => {
    const other = mitigated.buckets[index];
    return { t: bucket.startMs / 1000, original: value(bucket), mitigated: other ? value(other) : null };
  });
}

/** Successes within the deadline per second, by completion time. */
export function goodputRows(original: RunResult, mitigated: RunResult, bucketMs: Ms): ChartRow[] {
  return paired(original, mitigated, (bucket) => (bucket.goodput * 1000) / bucketMs);
}

/**
 * Success ratio (%) of the requests that arrived in the window ending at each step, as recovery measures it
 * (DESIGN.md §10.2). Null where no request arrived or outcomes are not known yet.
 */
export function successRatioRows(
  original: SummarizedRun,
  mitigated: SummarizedRun,
  deadlineMs: Ms,
  windowMs: Ms,
  stepMs: Ms,
): ChartRow[] {
  const windows = [original, mitigated].map((run) => ArrivalWindows.of(run.result, deadlineMs));
  const ratioAt = (index: number, end: Ms) => {
    const ratio = windows[index]?.ratio(end - windowMs, end) ?? null;
    return ratio === null ? null : ratio * 100;
  };
  const rows: ChartRow[] = [];
  for (let end = windowMs; end <= original.result.endedAtMs; end += stepMs) {
    rows.push({ t: end / 1000, original: ratioAt(0, end), mitigated: ratioAt(1, end) });
  }
  return rows;
}

export type ServiceMetric = 'maxQueueDepth' | 'retryArrivals' | 'wastedFraction';

/** One service's metric over time: queue depth, retry arrivals per second, or the wasted-work share (%). */
export function serviceRows(
  original: RunResult,
  mitigated: RunResult,
  service: string,
  metric: ServiceMetric,
  bucketMs: Ms,
): ChartRow[] {
  return paired(original, mitigated, (bucket) => {
    const s = bucket.services[service];
    if (!s) return null;
    if (metric === 'retryArrivals') return (s.retryArrivals * 1000) / bucketMs;
    if (metric === 'wastedFraction') return s.utilization > 0 ? s.wastedFraction * 100 : null;
    return s.maxQueueDepth;
  });
}
