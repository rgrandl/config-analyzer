import { describe, expect, it } from 'vitest';
import type { Ms, Scenario } from '../../../src/engine/config/schema';
import { compareRuns } from '../../../src/engine/simulator/compare';
import { simulator } from '../../../src/engine/simulator/run';
import { summarizeRun } from '../../../src/engine/simulator/summary';
import type { Runner } from '../../../src/engine/simulator/types';
import { call, scenario, service, system } from '../../helpers/fixtures';

// s (10 ms) calls a (10 ms) over 1 ms links; one request every 100 ms for 10 s.
const config = system(
  { s: service({ calls: [call('toA', 'a')] }), a: service() },
  { networkLatencyMs: 1, entry: { service: 's', deadlineMs: 1000 } },
);
const everyTenth = Array.from({ length: 100 }, (_, i) => i * 100);

describe('summarizeRun', () => {
  it('splits success and goodput into before, during and after the fault', () => {
    // Plan: a always errors between 4 s and 6 s; warm-up 1 s; the run is 10 s.
    // Verifies: success is 100% before, 0% during and 100% after; goodput is 10 requests/s outside the
    //   fault and 0 inside it; recovery is at the fault's end; there are no timeouts.
    const faulty = scenario({ warmupMs: 1000, faults: [{ service: 'a', startMs: 4000, endMs: 6000, errorRate: 1 }] });
    const summary = summarizeRun(simulator.run(config, faulty, everyTenth), config, faulty);
    expect(summary.successRatio).toEqual({ before: 1, during: 0, after: 1 });
    expect(summary.goodputPerSec.before).toBeCloseTo(10, 0);
    expect(summary.goodputPerSec.during).toBeLessThan(1);
    expect(summary.recovery.recoveryTimeMs).toBe(0);
    expect(summary.timeouts).toBe(0);
  });

  it('leaves the fault phases empty for a run without faults', () => {
    // Plan: summarize a run of the same system with no faults.
    // Verifies: the whole run after warm-up is "before"; "during" and "after" are null, and recovery does not apply.
    const quiet = scenario({ warmupMs: 1000 });
    const summary = summarizeRun(simulator.run(config, quiet, everyTenth), config, quiet);
    expect(summary.successRatio).toEqual({ before: 1, during: null, after: null });
    expect(summary.goodputPerSec.during).toBeNull();
    expect(summary.recovery.status).toBe('not-applicable');
  });

  it('reports wasted work per service', () => {
    // Plan: s calls a with a 20 ms timeout, but a takes 50 ms, so all of a's work is abandoned.
    // Verifies: a's wasted fraction is 1, while s, whose user still waits, wastes nothing.
    const slow = system(
      { s: service({ calls: [call('toA', 'a', { timeoutMs: 20 })] }), a: service({ serviceTimeMs: 50 }) },
      { networkLatencyMs: 1, entry: { service: 's', deadlineMs: 1000 } },
    );
    const quiet = scenario();
    const summary = summarizeRun(simulator.run(slow, quiet, everyTenth), slow, quiet);
    expect(summary.wastedFraction).toEqual({ s: 0, a: 1 });
  });
});

describe('compareRuns', () => {
  it('runs each config with and without faults on the same arrivals', () => {
    // Plan: compare a config with itself, through a runner that records what it was given.
    // Verifies: four runs, all with the same arrival times; two with the faults and two without.
    const seen: { faults: number; arrivals: readonly Ms[] }[] = [];
    const recording: Runner = {
      run: (sys, sc: Scenario, arrivals) => {
        seen.push({ faults: sc.faults.length, arrivals });
        return simulator.run(sys, sc, arrivals);
      },
    };
    const faulty = scenario({ faults: [{ service: 'a', startMs: 4000, endMs: 6000, errorRate: 1 }] });
    const comparison = compareRuns(config, config, faulty, recording);
    expect(seen.map((run) => run.faults)).toEqual([1, 0, 1, 0]);
    for (const run of seen) expect(run.arrivals).toEqual(comparison.arrivals);
    expect(comparison.original.withoutFaults.summary.recovery.status).toBe('not-applicable');
  });
});
