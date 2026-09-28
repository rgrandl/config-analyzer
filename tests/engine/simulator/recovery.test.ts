import { describe, expect, it } from 'vitest';
import { ArrivalWindows, computeRecovery, lowestWindowRatio } from '../../../src/engine/simulator/recovery';
import type { RequestOutcome, RunResult } from '../../../src/engine/simulator/types';
import type { Scenario } from '../../../src/engine/config/schema';
import { scenario } from '../../helpers/fixtures';

// Synthetic runs: one request every 10 ms from 0 to 30 s, the run ends at 31 s, and the user deadline is
// 1 s, so outcomes are known for arrivals before 30 s. A fault lasts from 10 s to 20 s.
const DEADLINE_MS = 1000;
const faulty = scenario({
  durationMs: 31_000,
  warmupMs: 2000,
  faults: [{ service: 'db', startMs: 10_000, endMs: 20_000, latencyMultiplier: 5 }],
});

/** Requests every `stepMs` in [0, 30 000), ok unless `fails(arrival)`. */
function requests(fails: (arrivalMs: number) => boolean, stepMs = 10): RequestOutcome[] {
  const list: RequestOutcome[] = [];
  for (let t = 0; t < 30_000; t += stepMs) list.push({ arrivalMs: t, completionMs: t + 50, ok: !fails(t) });
  return list;
}

function resultOf(list: RequestOutcome[], endedAtMs = 31_000, truncated = false): RunResult {
  return { buckets: [], requests: list, eventCount: 0, truncated, endedAtMs };
}

/** Recovery of a synthetic run under `faulty` (or another scenario). */
function recover(list: RequestOutcome[], options: { endedAtMs?: number; truncated?: boolean; sc?: Scenario } = {}) {
  const result = resultOf(list, options.endedAtMs, options.truncated);
  return computeRecovery(ArrivalWindows.of(result, DEADLINE_MS), options.sc ?? faulty, result.truncated);
}

describe('ArrivalWindows', () => {
  it('computes the success ratio of the requests that arrived in a window', () => {
    // Plan: requests every 10 ms; those arriving in [1000, 1500) fail.
    // Verifies: [1000, 2000) has 50 of 100 ok, [0, 1000) all ok, and a window with no arrivals is null.
    const windows = new ArrivalWindows(requests((t) => t >= 1000 && t < 1500), 30_000);
    expect(windows.ratio(1000, 2000)).toBe(0.5);
    expect(windows.ratio(0, 1000)).toBe(1);
    expect(windows.ratio(30_500, 31_000)).toBeNull();
  });
});

describe('computeRecovery', () => {
  it('finds the first time after which every window stays above the threshold for the hold period', () => {
    // Plan: requests fail from 10 s until 21.5 s. The window starting at 21.4 s holds 10 failures in 100
    //   (exactly the 90% threshold); the one starting at 21.3 s holds 20.
    // Verifies: recovered at 21.4 s, 1.4 s after the fault ended; a window exactly at the threshold counts.
    const recovery = recover(requests((t) => t >= 10_000 && t < 21_500));
    expect(recovery).toEqual({
      status: 'recovered',
      baselineRatio: 1,
      thresholdRatio: 0.9,
      recoveredAtMs: 21_400,
      recoveryTimeMs: 1400,
    });
  });

  it('reports no recovery when failures continue to the end', () => {
    // Plan: every request from 10 s on fails.
    // Verifies: not recovered.
    const recovery = recover(requests((t) => t >= 10_000));
    expect(recovery.status).toBe('not-recovered');
    expect(recovery.recoveredAtMs).toBeNull();
  });

  it('needs the whole hold period before the last usable arrival', () => {
    // Plan: failures end at 26.5 s, then at 27.5 s. Outcomes are known up to 30 s and the hold is 3 s, so the
    //   latest confirmable recovery time is 27 s.
    // Verifies: recovered at 26.4 s in the first case; in the second, 27.4 s cannot be confirmed in time.
    const early = recover(requests((t) => t >= 10_000 && t < 26_500));
    const late = recover(requests((t) => t >= 10_000 && t < 27_500));
    expect(early.recoveredAtMs).toBe(26_400);
    expect(late.status).toBe('not-recovered');
  });

  it('ignores requests whose outcome the run ended too early to know', () => {
    // Plan: failures end at 21.5 s, but every request after 29.5 s is marked failed without a response, as if
    //   the run ended before their deadline. The run ends at 30.5 s, so arrivals from 29.5 s on are unusable.
    // Verifies: they do not change the result: still recovered at 21.4 s.
    const list = requests((t) => (t >= 10_000 && t < 21_500) || t >= 29_500).map((r) =>
      r.arrivalMs >= 29_500 ? { ...r, completionMs: null } : r,
    );
    expect(recover(list, { endedAtMs: 30_500 }).recoveredAtMs).toBe(21_400);
  });

  it('skips windows with no arrivals, but never recovers on silence alone', () => {
    // Plan: (a) after the fault, requests arrive only every 1.5 s, so some 1 s windows are empty, and all
    //   succeed; (b) no requests at all arrive after the fault.
    // Verifies: (a) recovers at the fault's end, skipping the empty windows; (b) does not recover.
    const sparse = requests(() => false).filter((r) => r.arrivalMs < 20_000 || r.arrivalMs % 1500 === 0);
    const silent = requests((t) => t >= 10_000).filter((r) => r.arrivalMs < 20_000);
    expect(recover(sparse).recoveredAtMs).toBe(20_000);
    expect(recover(silent).status).toBe('not-recovered');
  });

  it('scales the threshold to the baseline', () => {
    // Plan: before the fault every 5th request fails (baseline 80%); from 21 s the same pattern returns.
    // Verifies: the threshold is 90% of 80% = 72%. The window starting at 20.9 s has 10 fault failures plus
    //   18 pattern failures, 72 ok of 100, exactly the threshold, so the run counts as recovered at 20.9 s.
    const everyFifth = (t: number) => t % 50 === 0;
    const recovery = recover(requests((t) => everyFifth(t) || (t >= 10_000 && t < 21_000)));
    expect(recovery.baselineRatio).toBeCloseTo(0.8);
    expect(recovery.thresholdRatio).toBeCloseTo(0.72);
    expect(recovery.recoveredAtMs).toBe(20_900);
  });

  it('measures recovery after the last of several faults', () => {
    // Plan: two faults, 10–12 s and 15–20 s; requests fail during both and until 21.5 s.
    // Verifies: the baseline is measured before the first fault (100%), and recovery is 1.4 s after the
    //   last fault ends, at 21.4 s.
    const twoFaults = scenario({
      durationMs: 31_000,
      warmupMs: 2000,
      faults: [
        { service: 'db', startMs: 10_000, endMs: 12_000, latencyMultiplier: 5 },
        { service: 'db', startMs: 15_000, endMs: 20_000, latencyMultiplier: 5 },
      ],
    });
    const failing = (t: number) => (t >= 10_000 && t < 12_000) || (t >= 15_000 && t < 21_500);
    expect(recover(requests(failing), { sc: twoFaults })).toMatchObject({ baselineRatio: 1, recoveredAtMs: 21_400, recoveryTimeMs: 1400 });
  });

  it('reports unknown, not "not recovered", when a truncated run ends before recovery can be confirmed', () => {
    // Plan: failures continue to the end of a run that stopped early at 22 s because it hit the event cap.
    // Verifies: the status is unknown; the same data from a run that was not truncated is "not recovered".
    const failing = requests((t) => t >= 10_000);
    expect(recover(failing, { endedAtMs: 22_000, truncated: true }).status).toBe('unknown');
    expect(recover(failing, { endedAtMs: 22_000, truncated: false }).status).toBe('not-recovered');
  });

  it('does not apply when nothing succeeded before the fault', () => {
    // Plan: every request fails, before, during and after the fault.
    // Verifies: the baseline is 0, so there is nothing to recover to: not applicable, rather than a
    //   threshold of 0 that every window would pass.
    expect(recover(requests(() => true))).toMatchObject({ status: 'not-applicable', baselineRatio: 0 });
  });

  it('checks the end of a hold that is not a multiple of the grid', () => {
    // Plan: a 3050 ms hold with 1 s windows, so the grid's last window, [22 000, 23 000), leaves the hold's
    //   last 50 ms unchecked for t = 20 000. Requests fail again in [22 900, 23 050): the grid window sees 10 of
    //   them (exactly 90%, passes), the final window [22 050, 23 050) sees 15 (85%, fails).
    // Verifies: t = 20 000 is not accepted, so the final window is checked; recovery comes later.
    const oddHold = scenario({ ...faulty, recovery: { thresholdPct: 90, windowMs: 1000, holdMs: 3050 } });
    const failing = (t: number) => (t >= 10_000 && t < 20_000) || (t >= 22_900 && t < 23_050);
    const recovery = recover(requests(failing), { sc: oddHold });
    expect(recovery.status).toBe('recovered');
    expect(recovery.recoveredAtMs).toBeGreaterThan(20_000);
  });

  it('does not apply without faults, but still measures the baseline', () => {
    // Plan: a run without faults where every request succeeds.
    // Verifies: status not-applicable, baseline 1.
    const recovery = recover(requests(() => false), { sc: scenario({ durationMs: 31_000, warmupMs: 2000 }) });
    expect(recovery).toMatchObject({ status: 'not-applicable', baselineRatio: 1 });
  });
});

describe('lowestWindowRatio', () => {
  it('finds the worst window after warm-up', () => {
    // Plan: requests in [5000, 5300) fail; windows are 1 s long.
    // Verifies: the lowest window holds 30 failures in 100, a ratio of 0.7.
    const windows = ArrivalWindows.of(resultOf(requests((t) => t >= 5000 && t < 5300)), DEADLINE_MS);
    expect(lowestWindowRatio(windows, 2000, 1000)).toBeCloseTo(0.7);
  });
});
