import { describe, expect, it } from 'vitest';
import { analyze } from '../../../src/engine/analyzer/analyze';
import type { Finding } from '../../../src/engine/analyzer/finding';
import {
  applyMitigations,
  classifyFindings,
  mergePatches,
} from '../../../src/engine/analyzer/mitigation/applyMitigations';
import { mergeValues, movesConservatively } from '../../../src/engine/analyzer/mitigation/patchableFields';
import { validateSystem } from '../../../src/engine/config/validate';
import { call, demoSystem, service, system } from '../../helpers/fixtures';

/** A synthetic finding carrying one patch, for testing the merge on its own. */
function findingWith(id: string, field: string, from: unknown, to: unknown, callName = 'toA'): Finding {
  const target = { service: 's', call: callName };
  return {
    id,
    rule: 'deadline-budget-overrun',
    severity: 'high',
    target,
    title: id,
    explanation: id,
    evidence: {},
    mitigation: { summary: id, patches: [{ target, field, from, to }] },
  };
}

describe('patchableFields', () => {
  it('merges each kind toward the more conservative value', () => {
    // Plan: merge pairs of values for each kind of field.
    // Verifies: lower → minimum ("unbounded" is largest), raise → maximum, enable → true, add-if-absent → first.
    expect(mergeValues('lower', 3, 2)).toBe(2);
    expect(mergeValues('lower', 'unbounded', 26)).toBe(26);
    expect(mergeValues('raise', 10, 20)).toBe(20);
    expect(mergeValues('enable', true, true)).toBe(true);
    expect(mergeValues('add-if-absent', { a: 1 }, { a: 2 })).toEqual({ a: 1 });
  });

  it('accepts only moves in the allowed direction', () => {
    // Plan: check a conservative and a non-conservative move for several kinds.
    // Verifies: lowering and enabling pass; raising a "lower" field, or overwriting an existing value, fail.
    expect(movesConservatively('lower', 3, 1)).toBe(true);
    expect(movesConservatively('lower', 'unbounded', 26)).toBe(true);
    expect(movesConservatively('lower', 1, 3)).toBe(false);
    expect(movesConservatively('enable', false, true)).toBe(true);
    expect(movesConservatively('add-if-absent', { baseMs: 5 }, { baseMs: 10 })).toBe(false);
  });
});

describe('mergePatches', () => {
  it('merges two findings that patch the same field into one patch, keeping the minimum', () => {
    // Plan: two findings lower s.toA's maxAttempts from 3, one to 2 and one to 1.
    // Verifies: a single patch to 1 that lists both findings.
    const merged = mergePatches([
      findingWith('first', 'maxAttempts', 3, 2),
      findingWith('second', 'maxAttempts', 3, 1),
    ]);
    expect(merged).toEqual([
      { target: { service: 's', call: 'toA' }, field: 'maxAttempts', from: 3, to: 1, findingIds: ['first', 'second'] },
    ]);
  });

  it('refuses a field outside the table and a move in the wrong direction', () => {
    // Plan: one finding patches workers (not patchable); another raises a timeout.
    // Verifies: both throw, so a faulty rule can never produce a less safe config.
    expect(() => mergePatches([findingWith('bad', 'workers', 10, 5)])).toThrow(/not patchable/);
    expect(() => mergePatches([findingWith('bad', 'timeoutMs', 100, 200)])).toThrow(/not a lower change/);
  });
});

describe('classifyFindings', () => {
  it('separates findings that remain from findings that are new', () => {
    // Plan: before = [a, b]; after the re-run = [b, c].
    // Verifies: b is unresolved and c is introduced; a was resolved and appears in neither.
    const make = (id: string) => findingWith(id, 'maxAttempts', 2, 1);
    const { unresolved, introduced } = classifyFindings([make('a'), make('b')], [make('b'), make('c')]);
    expect(unresolved.map((f) => f.id)).toEqual(['b']);
    expect(introduced.map((f) => f.id)).toEqual(['c']);
  });
});

describe('applyMitigations', () => {
  const demo = demoSystem();
  const { findings } = analyze(demo);
  const all = new Set(findings.map((f) => f.id));

  it('resolves every demo finding in one apply', () => {
    // Plan: apply all 12 demo findings.
    // Verifies: the re-run finds nothing unresolved and nothing new (DESIGN.md §11.3).
    const result = applyMitigations(demo, findings, all);
    expect(result.unresolved).toEqual([]);
    expect(result.introduced).toEqual([]);
  });

  it('merges the two findings that both reduce placeOrder to one attempt', () => {
    // Plan: apply all demo findings and look at the patch of api.placeOrder.maxAttempts.
    // Verifies: one patch 3 → 1, contributed by rules 1 and 2.
    const patch = applyMitigations(demo, findings, all).applied.find(
      (p) => p.target.call === 'placeOrder' && p.field === 'maxAttempts',
    );
    expect(patch).toMatchObject({
      from: 3,
      to: 1,
      findingIds: ['retry-amplification:api.placeOrder', 'deadline-budget-overrun:api.placeOrder'],
    });
  });

  it('never raises a timeout, attempts, a queue or the deadline, and keeps the config valid', () => {
    // Plan: apply all demo findings and compare every tightened setting with the original.
    // Verifies: each is equal or lower, the entry deadline is unchanged, and the result validates.
    const mitigated = applyMitigations(demo, findings, all).config;
    expect(mitigated.entry.deadlineMs).toBe(demo.entry.deadlineMs);
    for (const [name, original] of Object.entries(demo.services)) {
      const after = mitigated.services[name];
      if (!after) throw new Error(`Missing service ${name}`);
      const capacity = (value: number | 'unbounded') => (value === 'unbounded' ? Infinity : value);
      expect(capacity(after.queueCapacity)).toBeLessThanOrEqual(capacity(original.queueCapacity));
      original.calls.forEach((originalCall, index) => {
        expect(after.calls[index]?.timeoutMs).toBeLessThanOrEqual(originalCall.timeoutMs);
        expect(after.calls[index]?.maxAttempts).toBeLessThanOrEqual(originalCall.maxAttempts);
      });
    }
    expect(validateSystem(mitigated).ok).toBe(true);
  });

  it('applies only the selected findings and leaves the input untouched', () => {
    // Plan: select only the db queue finding.
    // Verifies: only the db queue changes; the other 11 findings remain unresolved; the input still says 1000.
    const result = applyMitigations(demo, findings, new Set(['dead-on-arrival-queue:db']));
    expect(result.applied.map((p) => `${p.target.service}.${p.field}`)).toEqual(['db.queueCapacity']);
    expect(result.config.services.db?.queueCapacity).toBe(26);
    expect(result.unresolved).toHaveLength(11);
    expect(demo.services.db?.queueCapacity).toBe(1000);
  });

  it('resolves a timeout overrun on a retrying call in one apply', () => {
    // Plan: a 3-attempt call with a 2000 ms timeout and a 990 ms share; apply every finding once.
    // Verifies: the call ends at one 990 ms attempt, the config validates, and nothing is unresolved or new,
    //   so the timeout mitigation does not rely on a second apply.
    const config = system({ s: service({ calls: [call('toA', 'a', { timeoutMs: 2000, maxAttempts: 3 })] }), a: service() });
    const before = analyze(config).findings;
    const result = applyMitigations(config, before, new Set(before.map((f) => f.id)));
    expect(result.config.services.s?.calls[0]).toMatchObject({ timeoutMs: 990, maxAttempts: 1 });
    expect(validateSystem(result.config).ok).toBe(true);
    expect(result.unresolved).toEqual([]);
    expect(result.introduced).toEqual([]);
  });

  it('finds nothing left to patch when applied a second time', () => {
    // Plan: apply all demo findings, analyze the result, and apply its findings again.
    // Verifies: the second analysis is empty and the second apply changes nothing.
    const first = applyMitigations(demo, findings, all);
    const second = applyMitigations(first.config, first.analysis.findings, new Set(first.analysis.findings.map((f) => f.id)));
    expect(first.analysis.findings).toEqual([]);
    expect(second.applied).toEqual([]);
    expect(second.config).toEqual(first.config);
  });

  it('refuses findings computed for a different config', () => {
    // Plan: analyze the demo, then apply its db queue finding to a copy whose db queue is 500 instead of 1000.
    // Verifies: the patch sees an unexpected current value and throws instead of silently applying a stale fix.
    const changed = demoSystem();
    if (changed.services.db) changed.services.db.queueCapacity = 500;
    expect(() => applyMitigations(changed, findings, new Set(['dead-on-arrival-queue:db']))).toThrow(/expected 1000/);
  });

  it('keeps a finding without a safe mitigation as unresolved', () => {
    // Plan: a call whose floor (2 × a's 600 ms p99) exceeds its 990 ms share, so rule 2 has no mitigation.
    // Verifies: after applying everything, that finding is still reported as unresolved.
    const config = system({
      s: service({ calls: [call('toA', 'a', { timeoutMs: 2000 })] }),
      a: service({ observedP99Ms: 600 }),
    });
    const before = analyze(config).findings;
    const result = applyMitigations(config, before, new Set(before.map((f) => f.id)));
    expect(result.unresolved.map((f) => f.id)).toContain('deadline-budget-overrun:s.toA');
  });

  it('produces a valid config when patching a backoff with baseMs 0 and maxMs 0', () => {
    // Plan: a retrying call with backoff { baseMs 0, maxMs 0 }; apply its unguarded-retries finding.
    // Verifies: the result validates (maxMs was raised with baseMs) and the finding is resolved.
    const config = system({
      s: service({
        calls: [
          call('toA', 'a', {
            maxAttempts: 2,
            backoff: { baseMs: 0, multiplier: 2, maxMs: 0, jitter: 'full' },
            retryBudget: { ratio: 0.1, maxTokens: 5 },
          }),
        ],
      }),
      a: service(),
    });
    const before = analyze(config).findings;
    const result = applyMitigations(config, before, new Set(['unguarded-retries:s.toA']));
    expect(validateSystem(result.config).ok).toBe(true);
    expect(result.config.services.s?.calls[0]?.backoff).toMatchObject({ baseMs: 10, maxMs: 10 });
    expect(result.analysis.findings.map((f) => f.id)).not.toContain('unguarded-retries:s.toA');
  });
});
