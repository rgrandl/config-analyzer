import { describe, expect, it } from 'vitest';
import { MetricsCollector } from '../../../src/engine/simulator/metrics';

// 1000 ms run in 250 ms buckets; service s has 2 workers; one call s.toA.
function collector(): MetricsCollector {
  return new MetricsCollector(250, 1000, [{ name: 's', workers: 2 }], ['s.toA']);
}

describe('MetricsCollector', () => {
  it('splits a job spanning several buckets across all of them', () => {
    // Plan: one worker is busy from 100 to 600 ms, and that work is wasted.
    // Verifies: 150, 250 and 100 ms land in buckets 0, 1 and 2, so utilization is 0.3, 0.5 and 0.2 of
    //   2 workers × 250 ms, and the wasted fraction is 1 where there was work and 0 elsewhere.
    const metrics = collector();
    metrics.workerTime('s', 100, 600, true);
    const buckets = metrics.finish().map((b) => b.services.s);
    expect(buckets.map((b) => b?.utilization)).toEqual([0.3, 0.5, 0.2, 0]);
    expect(buckets.map((b) => b?.wastedFraction)).toEqual([1, 1, 1, 0]);
  });

  it('carries queue depth into buckets without changes', () => {
    // Plan: the queue grows to 5 at 100 ms, stays there, and drops to 0 at 800 ms.
    // Verifies: the max depth is 5 in buckets 0 to 3; bucket 3 had 5 before it drained.
    const metrics = collector();
    metrics.queueDepth('s', 100, 5);
    metrics.queueDepth('s', 800, 0);
    expect(metrics.finish().map((b) => b.services.s?.maxQueueDepth)).toEqual([5, 5, 5, 5]);
  });

  it('uses the real length of a partial last bucket', () => {
    // Plan: a 900 ms run (last bucket 150 ms long); one worker busy for the whole last bucket.
    // Verifies: utilization is 150 / (2 × 150) = 0.5, not 150 / (2 × 250).
    const metrics = new MetricsCollector(250, 900, [{ name: 's', workers: 2 }], []);
    metrics.workerTime('s', 750, 900, false);
    expect(metrics.finish()[3]?.services.s?.utilization).toBe(0.5);
  });

  it('counts events in the bucket of their time', () => {
    // Plan: record user results and call events at various times.
    // Verifies: each count lands in its bucket, and retries count as attempts too.
    const metrics = collector();
    metrics.userResult(10, 'ok');
    metrics.userResult(300, 'late');
    metrics.userResult(999, 'failed');
    metrics.callAttempt('s.toA', 260, false);
    metrics.callAttempt('s.toA', 270, true);
    const buckets = metrics.finish();
    expect(buckets.map((b) => [b.goodput, b.lateSuccesses, b.failures])).toEqual([[1, 0, 0], [0, 1, 0], [0, 0, 0], [0, 0, 1]]);
    expect(buckets[1]?.calls['s.toA']).toMatchObject({ attempts: 2, retries: 1 });
  });
});
