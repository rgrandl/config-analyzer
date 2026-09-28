import { describe, expect, it } from 'vitest';
import { analyze } from '../../../src/engine/analyzer/analyze';
import { worstAttemptsPerRequest } from '../../../src/engine/analyzer/rules/retryAmplification';
import { CallGraph } from '../../../src/engine/config/callGraph';
import type { Finding, RuleId } from '../../../src/engine/analyzer/finding';
import type { SystemConfig } from '../../../src/engine/config/schema';
import { call, demoSystem, service, system } from '../../helpers/fixtures';

// Hand-made systems below use zero network latency and a 1000 ms deadline unless stated otherwise;
// services take 10 ms with no jitter, so each call's floor is 2 × (10 ms per service on the way down).

function findingsOf(config: SystemConfig, rule: RuleId): Finding[] {
  return analyze(config).findings.filter((finding) => finding.rule === rule);
}

describe('retry-amplification', () => {
  it('flags a retrying call that has a retrying call below it', () => {
    // Plan: s → a retries 3 times, and a → b retries 2 times.
    // Verifies: s.toA is flagged with 3 × 2 = 6 worst-case attempts at b, and its patch makes it a single attempt.
    const findings = findingsOf(
      system({
        s: service({ calls: [call('toA', 'a', { maxAttempts: 3 })] }),
        a: service({ calls: [call('toB', 'b', { maxAttempts: 2 })] }),
        b: service(),
      }),
      'retry-amplification',
    );
    expect(findings.map((f) => f.id)).toEqual(['retry-amplification:s.toA']);
    expect(findings[0]?.evidence.worstAttemptsPerRequest).toBe(6);
    expect(findings[0]?.mitigation?.patches).toEqual([
      { target: { service: 's', call: 'toA' }, field: 'maxAttempts', from: 3, to: 1 },
    ]);
  });

  it('flags every retrying layer except the deepest in a longer chain', () => {
    // Plan: s → a → b → c, where every call retries 3 times.
    // Verifies: s.toA and a.toB are flagged; b.toC, the deepest, keeps its retries.
    const config = system({
      s: service({ calls: [call('toA', 'a', { maxAttempts: 3 })] }),
      a: service({ calls: [call('toB', 'b', { maxAttempts: 3 })] }),
      b: service({ calls: [call('toC', 'c', { maxAttempts: 3 })] }),
      c: service(),
    });
    expect(findingsOf(config, 'retry-amplification').map((f) => f.id)).toEqual([
      'retry-amplification:s.toA',
      'retry-amplification:a.toB',
    ]);
  });

  it('adds up attempts from every path when counting per request', () => {
    // Plan: a diamond: s → a (2 attempts) → d (2 attempts), and s → b (3 attempts) → d (1 attempt).
    // Verifies: d receives up to 2 × 2 + 3 × 1 = 7 attempts per request.
    const graph = new CallGraph({
      s: service({ calls: [call('toA', 'a', { maxAttempts: 2 }), call('toB', 'b', { maxAttempts: 3 })] }),
      a: service({ calls: [call('toD', 'd', { maxAttempts: 2 })] }),
      b: service({ calls: [call('toD', 'd')] }),
      d: service(),
    });
    expect(worstAttemptsPerRequest(graph, 's').get('d')).toBe(7);
  });

  it('leaves retries alone when only the deepest layer retries', () => {
    // Plan: s → a is a single attempt, and a → b retries 3 times.
    // Verifies: no finding; retrying at the deepest layer is the recommended setup.
    const config = system({
      s: service({ calls: [call('toA', 'a')] }),
      a: service({ calls: [call('toB', 'b', { maxAttempts: 3 })] }),
      b: service(),
    });
    expect(findingsOf(config, 'retry-amplification')).toEqual([]);
  });
});

describe('deadline-budget-overrun', () => {
  it('lowers a timeout that does not fit even once, down to the share', () => {
    // Plan: s (10 ms of work, 1000 ms budget) calls a once with a 2000 ms timeout.
    // Verifies: the call's share is 990 ms, so the patch sets the timeout to exactly 990 ms.
    const findings = findingsOf(
      system({ s: service({ calls: [call('toA', 'a', { timeoutMs: 2000 })] }), a: service() }),
      'deadline-budget-overrun',
    );
    expect(findings[0]?.mitigation?.patches).toEqual([
      { target: { service: 's', call: 'toA' }, field: 'timeoutMs', from: 2000, to: 990 },
    ]);
  });

  it('offers no mitigation when even a healthy attempt cannot fit', () => {
    // Plan: as above, but a's observed p99 is 600 ms, so the floor is 2 × 600 = 1200 ms, above the 990 ms share.
    // Verifies: the finding is reported with no mitigation rather than a timeout that would cut healthy requests.
    const findings = findingsOf(
      system({ s: service({ calls: [call('toA', 'a', { timeoutMs: 2000 })] }), a: service({ observedP99Ms: 600 }) }),
      'deadline-budget-overrun',
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.mitigation).toBeNull();
  });

  it('reports local work that exceeds the budget once, and not the starved services below', () => {
    // Plan: s's own work (1500 ms) exceeds its 1000 ms deadline; s calls a, which has a huge queue.
    // Verifies: one service-level finding on s without a mitigation, and nothing on a from rules 2 or 5.
    const config = system({
      s: service({ serviceTimeMs: 1500, calls: [call('toA', 'a')] }),
      a: service({ queueCapacity: 'unbounded' }),
    });
    const findings = analyze(config).findings.filter(
      (f) => f.rule === 'deadline-budget-overrun' || f.rule === 'dead-on-arrival-queue',
    );
    expect(findings.map((f) => f.id)).toEqual(['deadline-budget-overrun:s']);
    expect(findings[0]?.mitigation).toBeNull();
    expect(findings[0]?.explanation).toMatch(/user's deadline/);
  });

  it('reports a timeout shorter than the callee needs when healthy', () => {
    // Plan: s calls a with a 12 ms timeout, but a takes 15 ms even with no load.
    // Verifies: one finding on a, "cannot finish even when healthy", with no mitigation (timeouts are never
    //   raised), and no queue finding on a.
    const config = system({ s: service({ calls: [call('toA', 'a', { timeoutMs: 12 })] }), a: service({ serviceTimeMs: 15 }) });
    const onA = analyze(config).findings.filter((f) => f.target.service === 'a' && f.rule !== 'missing-deadline-propagation');
    expect(onA.map((f) => f.id)).toEqual(['deadline-budget-overrun:a']);
    expect(onA[0]?.mitigation).toBeNull();
    expect(onA[0]?.explanation).toMatch(/calls into a leave it 12 ms/);
  });

  it('skips a service starved by a share at or below the round trip', () => {
    // Plan: with 1 ms links, s (996 ms of work) leaves only 2 ms, one round trip, for its call to a.
    // Verifies: a's budget is 0, so rules 2 and 5 say nothing about a; s's own finding explains the cause.
    const config = system(
      { s: service({ serviceTimeMs: 996, calls: [call('toA', 'a')] }), a: service({ queueCapacity: 'unbounded' }) },
      { networkLatencyMs: 1 },
    );
    const { findings, budgets } = analyze(config);
    expect(budgets.service('a').budgetMs).toBe(0);
    const budgetFindings = findings.filter((f) => f.rule === 'deadline-budget-overrun' || f.rule === 'dead-on-arrival-queue');
    expect(budgetFindings.map((f) => f.id)).toEqual(['deadline-budget-overrun:s']);
  });

  it('counts backoff when choosing how many attempts fit', () => {
    // Plan: a 4-attempt call of 300 ms with backoff 100, 200, 400 ms and a 990 ms share. Without backoff, 3
    //   attempts (900 ms) would fit; with it, 3 need 900 + 100 + 200 = 1200 ms and 2 need 600 + 100 = 700 ms.
    // Verifies: the patch reduces attempts to 2, not 3.
    const backoff = { baseMs: 100, multiplier: 2, maxMs: 400, jitter: 'full' as const };
    const [finding] = findingsOf(
      system({ s: service({ calls: [call('toA', 'a', { timeoutMs: 300, maxAttempts: 4, backoff })] }), a: service() }),
      'deadline-budget-overrun',
    );
    expect(finding?.mitigation?.patches).toEqual([
      { target: { service: 's', call: 'toA' }, field: 'maxAttempts', from: 4, to: 2 },
    ]);
  });

  it('lowers the timeout and makes the call a single attempt when it retries', () => {
    // Plan: a 3-attempt call with a 2000 ms timeout and a 990 ms share.
    // Verifies: one mitigation with both patches, timeout → 990 ms and attempts → 1, since after lowering the
    //   timeout to the share a second attempt could never fit.
    const [finding] = findingsOf(
      system({ s: service({ calls: [call('toA', 'a', { timeoutMs: 2000, maxAttempts: 3 })] }), a: service() }),
      'deadline-budget-overrun',
    );
    expect(finding?.mitigation?.patches.map((p) => [p.field, p.to])).toEqual([
      ['timeoutMs', 990],
      ['maxAttempts', 1],
    ]);
  });

  it('does not flag a worst case exactly equal to the share', () => {
    // Plan: with 0.1 ms links and 0.1 ms of local work, the call's share is 1000 − 0.2 − 0.1 = 999.7 ms, which
    //   floating point computes as 999.6999999999999; set the timeout to exactly 999.7 ms.
    // Verifies: no finding, because comparisons use a tolerance instead of flagging a 1e-13 ms "overrun".
    const config = system(
      { s: service({ serviceTimeMs: 0.1, calls: [call('toA', 'a', { timeoutMs: 999.7 })] }), a: service() },
      { networkLatencyMs: 0.1 },
    );
    expect(analyze(config).budgets.call('s.toA').shareMs).toBeLessThan(999.7);
    expect(findingsOf(config, 'deadline-budget-overrun')).toEqual([]);
  });
});

describe('unguarded-retries', () => {
  const retrying = (overrides: Parameters<typeof call>[2]) =>
    system({ s: service({ calls: [call('toA', 'a', { maxAttempts: 2, ...overrides })] }), a: service() });

  it('adds a backoff and a retry budget where both are missing', () => {
    // Plan: a 2-attempt call with no guards.
    // Verifies: one finding with two patches: the default backoff and the default retry budget.
    const [finding] = findingsOf(retrying({}), 'unguarded-retries');
    expect(finding?.mitigation?.patches.map((p) => [p.field, p.to])).toEqual([
      ['backoff', { baseMs: 10, multiplier: 2, maxMs: 100, jitter: 'full' }],
      ['retryBudget', { ratio: 0.1, maxTokens: 10 }],
    ]);
  });

  it('treats baseMs 0 as no backoff, exactly as the budget math assumes', () => {
    // Plan: a retrying call with backoff { baseMs 0, maxMs 0, jitter full } and a retry budget.
    // Verifies: the patches raise baseMs and maxMs to 10 ms, the same values effectiveBackoff assumed.
    const [finding] = findingsOf(
      retrying({ backoff: { baseMs: 0, multiplier: 2, maxMs: 0, jitter: 'full' }, retryBudget: { ratio: 0.1, maxTokens: 5 } }),
      'unguarded-retries',
    );
    expect(finding?.mitigation?.patches.map((p) => [p.field, p.to])).toEqual([
      ['backoff.baseMs', 10],
      ['backoff.maxMs', 10],
    ]);
  });

  it('adds only jitter when that is all that is missing', () => {
    // Plan: a retrying call with a real backoff without jitter, and a retry budget.
    // Verifies: a single patch setting jitter to "full".
    const [finding] = findingsOf(
      retrying({ backoff: { baseMs: 20, multiplier: 2, maxMs: 80, jitter: 'none' }, retryBudget: { ratio: 0.1, maxTokens: 5 } }),
      'unguarded-retries',
    );
    expect(finding?.mitigation?.patches.map((p) => [p.field, p.to])).toEqual([['backoff.jitter', 'full']]);
  });

  it('ignores single-attempt calls and fully guarded retries', () => {
    // Plan: a single-attempt call, and a retrying call with backoff, jitter and a retry budget.
    // Verifies: neither is flagged.
    expect(findingsOf(retrying({ maxAttempts: 1 }), 'unguarded-retries')).toEqual([]);
    const guarded = retrying({
      backoff: { baseMs: 20, multiplier: 2, maxMs: 80, jitter: 'full' },
      retryBudget: { ratio: 0.1, maxTokens: 5 },
    });
    expect(findingsOf(guarded, 'unguarded-retries')).toEqual([]);
  });
});

describe('missing-deadline-propagation', () => {
  it('flags only services that do not propagate deadlines', () => {
    // Plan: s propagates deadlines and a does not.
    // Verifies: only a is flagged, with a patch enabling propagation.
    const findings = findingsOf(
      system({ s: service({ deadlinePropagation: true, calls: [call('toA', 'a')] }), a: service() }),
      'missing-deadline-propagation',
    );
    expect(findings.map((f) => f.id)).toEqual(['missing-deadline-propagation:a']);
    expect(findings[0]?.mitigation?.patches[0]).toMatchObject({ field: 'deadlinePropagation', to: true });
  });
});

describe('dead-on-arrival-queue', () => {
  // A single service: 1 worker, 10 ms per request, so it completes 0.1 requests/ms.
  const single = (queueCapacity: number | 'unbounded', deadlineMs: number) =>
    system({ s: service({ workers: 1, queueCapacity }) }, { entry: { service: 's', deadlineMs } });

  it('caps an unbounded queue', () => {
    // Plan: an unbounded queue with a 1000 ms deadline.
    // Verifies: the cap is ⌊0.1 × (1000 − 10) × 0.5⌋ = 49.
    const [finding] = findingsOf(single('unbounded', 1000), 'dead-on-arrival-queue');
    expect(finding?.mitigation?.patches[0]).toMatchObject({ field: 'queueCapacity', from: 'unbounded', to: 49 });
  });

  it('leaves a queue alone when a full one still drains in time', () => {
    // Plan: a queue of 10 with a 1000 ms deadline: at most 100 ms of waiting plus 10 ms of work.
    // Verifies: no finding.
    expect(findingsOf(single(10, 1000), 'dead-on-arrival-queue')).toEqual([]);
  });

  it('offers no mitigation when the cap would not be smaller than today', () => {
    // Plan: a queue of 1 with a 15 ms deadline: 10 ms of waiting plus 10 ms of work is too long, but the
    //   recommended cap is still 1.
    // Verifies: the finding has no mitigation, since a patch that changes nothing would look like a fix.
    const [finding] = findingsOf(single(1, 15), 'dead-on-arrival-queue');
    expect(finding).toBeDefined();
    expect(finding?.mitigation).toBeNull();
  });

  it('leaves a service that cannot finish even when healthy to rule 2', () => {
    // Plan: a 10 ms service with an 8 ms deadline and a queue of 10.
    // Verifies: rule 5 stays silent; no queue size helps, and rule 2 reports the real problem.
    expect(findingsOf(single(10, 8), 'dead-on-arrival-queue')).toEqual([]);
    expect(findingsOf(single(10, 8), 'deadline-budget-overrun').map((f) => f.id)).toEqual(['deadline-budget-overrun:s']);
  });
});

describe('finding text', () => {
  it('never shows undefined or NaN in titles, explanations or summaries', () => {
    // Plan: collect every finding of the demo and of configs that hit each rule branch, including
    //   unbounded queues, missing mitigations and a service that cannot finish.
    // Verifies: no text contains "undefined" or "NaN", which would mean a missing or broken value.
    const configs = [
      demoSystem(),
      system({ s: service({ workers: 1, queueCapacity: 'unbounded', calls: [call('toA', 'a', { timeoutMs: 2000, maxAttempts: 3 })] }), a: service({ observedP99Ms: 600 }) }),
      system({ s: service({ serviceTimeMs: 1500, calls: [call('toA', 'a', { maxAttempts: 2 })] }), a: service() }),
      system({ s: service({ workers: 1, queueCapacity: 1 }) }, { entry: { service: 's', deadlineMs: 15 } }),
    ];
    const texts = configs
      .flatMap((config) => analyze(config).findings)
      .flatMap((f) => [f.title, f.explanation, f.mitigation?.summary ?? '']);
    expect(texts.length).toBeGreaterThan(20);
    for (const text of texts) expect(text).not.toMatch(/undefined|NaN/);
  });
});
