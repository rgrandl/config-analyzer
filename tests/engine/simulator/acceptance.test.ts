// The demo's acceptance criteria (DESIGN.md §11.4), checked for five seeds. This is the proof behind the
// demo's story: the original config stays broken after the fault, and the mitigated one recovers.
import { describe, expect, it } from 'vitest';
import { analyze } from '../../../src/engine/analyzer/analyze';
import { applyMitigations } from '../../../src/engine/analyzer/mitigation/applyMitigations';
import { compareRuns } from '../../../src/engine/simulator/compare';
import { demoScenario, demoSystem } from '../../helpers/fixtures';

const original = demoSystem();
const { findings } = analyze(original);
const mitigated = applyMitigations(original, findings, new Set(findings.map((f) => f.id))).config;

describe.each([1, 2, 3, 4, 5])('demo acceptance, seed %i', (seed) => {
  const { original: before, mitigated: after } = compareRuns(original, mitigated, { ...demoScenario(), seed });
  const allRuns = [before.withFaults, before.withoutFaults, after.withFaults, after.withoutFaults];

  it('runs every scenario to the end, from a healthy baseline', () => {
    // Plan: check the preconditions of the criteria below on all four runs.
    // Verifies: no run was truncated (which would make "not recovered" meaningless), and every run starts
    //   from a baseline of at least 99% (a broken baseline would make the threshold meaningless).
    for (const run of allRuns) {
      expect(run.result.truncated).toBe(false);
      expect(run.summary.recovery.baselineRatio ?? 0).toBeGreaterThanOrEqual(0.99);
    }
  });

  it('keeps the original config broken after the fault ends', () => {
    // Plan: run the original config through the 10 s db slowdown.
    // Verifies: it does not recover within the run, and almost no request after the fault succeeds.
    expect(before.withFaults.summary.recovery.status).toBe('not-recovered');
    expect(before.withFaults.summary.successRatio.after).toBeLessThan(0.1);
  });

  it('stays broken for the reason in DESIGN.md §9.4', () => {
    // Plan: look at the db in the original run from 5 s after the fault to the end.
    // Verifies: its queue stays full (1000) and at least 95% of its work is for callers that already gave up,
    //   so the failure persists because of the stale-work loop, not for some other reason.
    const afterFault = before.withFaults.result.buckets.filter((bucket) => bucket.startMs >= 25_000);
    for (const bucket of afterFault) {
      expect(bucket.services.db?.maxQueueDepth).toBe(1000);
      expect(bucket.services.db?.wastedFraction).toBeGreaterThanOrEqual(0.95);
    }
  });

  it('recovers the mitigated config within 5 s of the fault ending', () => {
    // Plan: run the mitigated config through the same slowdown, on the same arrivals.
    // Verifies: it recovers, within 5 s.
    const { recovery } = after.withFaults.summary;
    expect(recovery.status).toBe('recovered');
    expect(recovery.recoveryTimeMs).toBeLessThanOrEqual(5000);
  });

  it('keeps both configs above the recovery threshold without the fault', () => {
    // Plan: run both configs on the same arrivals with no fault.
    // Verifies: no window after warm-up drops below 90% of the baseline.
    for (const runs of [before, after]) {
      const { lowestWindowRatio, recovery } = runs.withoutFaults.summary;
      expect(lowestWindowRatio).not.toBeNull();
      expect(lowestWindowRatio ?? 0).toBeGreaterThanOrEqual(0.9 * (recovery.baselineRatio ?? 1));
    }
  });

  it('gives the mitigated config essentially no false timeouts', () => {
    // Plan: count timeouts in the mitigated run without the fault, where none should be needed.
    // Verifies: at most 0.1% of attempts time out, so no mitigated timeout is too tight.
    expect(after.withoutFaults.summary.timeoutFraction).toBeLessThanOrEqual(0.001);
  });
});
