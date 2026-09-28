// Rule 3 (DESIGN.md §7): a retrying call without backoff, jitter or a retry budget. Such retries arrive
// immediately, in sync, and without limit, exactly when the callee is struggling.
import type { CallEdge } from '../../config/callGraph';
import { effectiveBackoff } from '../budget';
import { DEFAULT_BACKOFF, DEFAULT_RETRY_BUDGET } from '../defaults';
import type { Finding, Patch } from '../finding';
import { listPhrase } from '../text';
import { callTarget, describeCall, findingId, type Rule } from './rule';

export const unguardedRetries: Rule = {
  id: 'unguarded-retries',
  check({ graph }) {
    const findings: Finding[] = [];
    for (const edge of graph.calls) {
      if (edge.config.maxAttempts <= 1) continue;
      const { missing, patches } = missingGuards(edge);
      if (patches.length === 0) continue;

      const target = callTarget(edge);
      const lacking = listPhrase(missing);
      findings.push({
        id: findingId('unguarded-retries', target),
        rule: 'unguarded-retries',
        severity: 'medium',
        target,
        title: `${describeCall(edge)} retries without ${lacking}`,
        explanation:
          `${describeCall(edge)} makes up to ${edge.config.maxAttempts} attempts without ${lacking}. ` +
          'Retries then go out immediately, in step with other clients, and without a limit, which adds load ' +
          'exactly when the callee is struggling.',
        evidence: { maxAttempts: edge.config.maxAttempts, missing: missing.join(', ') },
        mitigation: { summary: `Add ${lacking}`, patches },
      });
    }
    return findings;
  },
};

/**
 * The guards a retrying call lacks, and the patches that add them. The backoff patches produce exactly
 * effectiveBackoff(call), which the budget math already assumed.
 */
function missingGuards(edge: CallEdge): { missing: string[]; patches: Patch[] } {
  const target = callTarget(edge);
  const { backoff, retryBudget } = edge.config;
  const missing: string[] = [];
  const patches: Patch[] = [];

  if (!backoff) {
    missing.push('backoff', 'jitter');
    patches.push({ target, field: 'backoff', from: undefined, to: { ...DEFAULT_BACKOFF } });
  } else {
    if (backoff.baseMs === 0) {
      const effective = effectiveBackoff(edge.config);
      missing.push('backoff');
      patches.push({ target, field: 'backoff.baseMs', from: 0, to: effective?.baseMs });
      if (effective && effective.maxMs !== backoff.maxMs) {
        patches.push({ target, field: 'backoff.maxMs', from: backoff.maxMs, to: effective.maxMs });
      }
    }
    if (backoff.jitter === 'none') {
      missing.push('jitter');
      patches.push({ target, field: 'backoff.jitter', from: 'none', to: 'full' });
    }
  }
  if (!retryBudget) {
    missing.push('a retry budget');
    patches.push({ target, field: 'retryBudget', from: undefined, to: { ...DEFAULT_RETRY_BUDGET } });
  }
  return { missing, patches };
}
