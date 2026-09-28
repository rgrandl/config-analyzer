// What every rule receives and returns. A rule is a plain object in the RULES array (rules/index.ts),
// so adding one means writing one file and listing it there.
import type { CallEdge, CallGraph } from '../../config/callGraph';
import type { AnalyzerOptions, SystemConfig } from '../../config/schema';
import type { Budgets } from '../budget';
import { exceeds, fits } from '../compare';
import { targetKey, type Finding, type RuleId, type Target } from '../finding';
import { formatMs, plural } from '../text';

export interface RuleContext {
  readonly system: SystemConfig;
  readonly graph: CallGraph;
  readonly budgets: Budgets;
  readonly options: AnalyzerOptions;
}

export interface Rule {
  readonly id: RuleId;
  check(context: RuleContext): Finding[];
}

export function serviceTarget(service: string): Target {
  return { service };
}

export function callTarget(edge: CallEdge): Target {
  return { service: edge.caller, call: edge.config.name };
}

/** Stable id: "<rule>:<service>" or "<rule>:<service>.<call>". */
export function findingId(rule: RuleId, target: Target): string {
  return `${rule}:${targetKey(target)}`;
}

/** "orders → db (readStock)", for titles and explanations. */
export function describeCall(edge: CallEdge): string {
  return `${edge.caller} → ${edge.callee} (${edge.config.name})`;
}

/**
 * A service whose budget is 0 got no time from its callers. Budget rules skip it: the caller's own finding
 * explains the cause, and flagging every service below would bury it (DESIGN.md §7).
 */
export function isStarved(context: RuleContext, service: string): boolean {
  return fits(context.budgets.service(service).budgetMs, 0);
}

/**
 * A service that cannot finish in the time it has even when healthy (budget < healthy latency): its own work
 * and calls are too slow for its callers' timeouts or the user's deadline. Rule 2 reports it once, and rules
 * 2 and 5 skip its individual checks, since no attempt count or queue size can fix it (DESIGN.md §7).
 */
export function cannotFinishWhenHealthy(context: RuleContext, service: string): boolean {
  const budget = context.budgets.service(service);
  return exceeds(budget.healthyMs, budget.budgetMs);
}

/**
 * Where a service's budget comes from, as a clause for explanations: "the user's 1000 ms deadline minus a
 * 2 ms network round trip", or "the 900 ms timeout of api → orders (placeOrder) minus ...".
 */
export function budgetOrigin(context: RuleContext, service: string): string {
  const source = context.budgets.service(service).budgetSource;
  const origin =
    source.kind === 'deadline'
      ? `the user's ${formatMs(source.deadlineMs)} deadline`
      : source.limitedBy === 'timeout'
        ? `the ${formatMs(source.limitMs)} timeout of ${source.caller} → ${service} (${source.call})`
        : `the ${formatMs(source.limitMs)} ${source.caller} has left for ${source.caller} → ${service} (${source.call})`;
  const { rttMs } = context.budgets;
  return rttMs > 0 ? `${origin} minus a ${formatMs(rttMs)} network round trip` : origin;
}

/**
 * What caps a service's throughput, when it is a service below it, as a parenthetical for explanations:
 * " (limited by db, which completes 400 requests/s: each request makes 2 calls to it)". Empty when the
 * service's own workers are the limit.
 */
export function throughputOrigin(context: RuleContext, service: string): string {
  const limit = context.budgets.service(service).throughputLimit;
  if (limit.kind === 'workers') return '';
  return (
    ` (limited by ${limit.bottleneck}, which completes ${Math.round(limit.bottleneckPerMs * 1000)} requests/s: ` +
    `each request makes ${plural(limit.callsPerRequest, 'call')} to it)`
  );
}
