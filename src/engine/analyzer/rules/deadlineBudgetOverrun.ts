// Rule 2 (DESIGN.md §7): a call whose attempts, with backoff, can take longer than the time its caller
// has for it. Later attempts then run after the caller has already given up.
import type { CallEdge } from '../../config/callGraph';
import { worstCaseMs, type CallBudget } from '../budget';
import { exceeds, fits } from '../compare';
import type { Finding, Mitigation, Patch } from '../finding';
import { formatMs, plural } from '../text';
import {
  callTarget,
  cannotFinishWhenHealthy,
  findingId,
  nameOf,
  isStarved,
  serviceTarget,
  budgetOrigin,
  type Rule,
  type RuleContext,
} from './rule';

export const deadlineBudgetOverrun: Rule = {
  id: 'deadline-budget-overrun',
  check(context) {
    const findings: Finding[] = [];
    for (const service of context.graph.services) {
      if (isStarved(context, service)) continue;
      // Too slow even when healthy: one finding for the service, instead of one per call.
      if (cannotFinishWhenHealthy(context, service)) {
        findings.push(tooSlowForBudget(context, service));
        continue;
      }
      for (const edge of context.graph.callsOf(service)) {
        const call = context.budgets.call(edge.id);
        if (exceeds(call.worstCaseMs, call.shareMs)) findings.push(callOverrun(context, edge, call));
      }
    }
    return findings;
  },
};

function callOverrun(context: RuleContext, edge: CallEdge, call: CallBudget): Finding {
  const target = callTarget(edge);
  const { timeoutMs, maxAttempts } = edge.config;
  const budgetMs = context.budgets.service(edge.caller).budgetMs;
  const before = edge.index === 0 ? 'Its local work' : 'Its local work and earlier calls';
  const reserve = call.reserveMs > 0 ? `, and later calls need ${formatMs(call.reserveMs)}` : '';
  return {
    id: findingId('deadline-budget-overrun', target),
    rule: 'deadline-budget-overrun',
    severity: 'high',
    target,
    // "left" when earlier work or later calls already take part of the caller's time.
    title:
      `${nameOf(context.graph, edge)} can take ${formatMs(call.worstCaseMs)}, but ${edge.caller} has ` +
      `${formatMs(call.shareMs)}${edge.index > 0 || call.reserveMs > 0 ? ' left' : ''} for it`,
    explanation:
      `${edge.caller} has ${formatMs(budgetMs)}: ${budgetOrigin(context, edge.caller)}. ${before} can take up to ${formatMs(call.elapsedBeforeMs)}` +
      `${reserve}, leaving ${formatMs(call.shareMs)} for this call. ${plural(maxAttempts, 'attempt')} of ` +
      `${formatMs(timeoutMs)} can take ${formatMs(call.worstCaseMs)}, so later attempts run after the caller has given up.`,
    evidence: {
      budgetMs,
      elapsedBeforeMs: call.elapsedBeforeMs,
      reserveMs: call.reserveMs,
      shareMs: call.shareMs,
      worstCaseMs: call.worstCaseMs,
      floorMs: call.floorMs,
    },
    mitigation: overrunMitigation(edge, call),
  };
}

/**
 * One conservative change that resolves the overrun on its own, never raising anything:
 * - one attempt fits: keep the timeout, use the most attempts that fit;
 * - one attempt does not fit but the floor does: lower the timeout to the share (exact, not rounded) and,
 *   since a second attempt would then need at least twice the share, make it a single attempt;
 * - otherwise there is no safe automatic change.
 */
function overrunMitigation(edge: CallEdge, call: CallBudget): Mitigation | null {
  const target = callTarget(edge);
  const { timeoutMs, maxAttempts } = edge.config;

  if (fits(timeoutMs, call.shareMs)) {
    let attempts = maxAttempts - 1;
    while (attempts > 1 && exceeds(worstCaseMs(edge.config, attempts, timeoutMs), call.shareMs)) attempts--;
    return {
      summary: `Reduce attempts to ${attempts} (worst case ${formatMs(worstCaseMs(edge.config, attempts, timeoutMs))})`,
      patches: [{ target, field: 'maxAttempts', from: maxAttempts, to: attempts }],
    };
  }
  if (fits(call.floorMs, call.shareMs)) {
    const patches: Patch[] = [{ target, field: 'timeoutMs', from: timeoutMs, to: call.shareMs }];
    if (maxAttempts > 1) patches.push({ target, field: 'maxAttempts', from: maxAttempts, to: 1 });
    return {
      summary:
        maxAttempts > 1
          ? `Lower the timeout to ${formatMs(call.shareMs)} and make it a single attempt`
          : `Lower the timeout to ${formatMs(call.shareMs)}`,
      patches,
    };
  }
  return null;
}

function tooSlowForBudget(context: RuleContext, service: string): Finding {
  const target = serviceTarget(service);
  const { budgetMs, healthyMs, svcMaxMs } = context.budgets.service(service);
  return {
    id: findingId('deadline-budget-overrun', target),
    rule: 'deadline-budget-overrun',
    severity: 'high',
    target,
    title: `${service} needs ${formatMs(healthyMs)} even when healthy, but gets ${formatMs(budgetMs)}`,
    explanation:
      `${service} has ${formatMs(budgetMs)} (${budgetOrigin(context, service)}), but it needs up to ${formatMs(healthyMs)} with no load (${formatMs(svcMaxMs)} of its own work, ` +
      'the rest in its calls). Every request can time out even on a quiet system. This needs faster services, ' +
      'or a decision to give it more time; the analyzer never raises timeouts or deadlines itself.',
    evidence: { budgetMs, healthyMs, svcMaxMs },
    mitigation: null,
  };
}
