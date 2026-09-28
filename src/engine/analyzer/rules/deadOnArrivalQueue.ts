// Rule 5 (DESIGN.md §7): a queue that can hold more work than the service can finish before its caller
// gives up. The requests at the back are dead on arrival: they are served after nobody waits for them.
import { exceeds } from '../compare';
import { QUEUE_HEADROOM } from '../defaults';
import type { Finding, Mitigation } from '../finding';
import { formatDuration, formatMs } from '../text';
import { budgetOrigin, cannotFinishWhenHealthy, findingId, serviceTarget, throughputOrigin, waiter, type Rule } from './rule';

export const deadOnArrivalQueue: Rule = {
  id: 'dead-on-arrival-queue',
  check(context) {
    const findings: Finding[] = [];
    for (const service of context.graph.services) {
      // Too-slow services are reported by rule 2, and no queue size would help them. This includes starved
      // services: a budget of 0 is always below the healthy latency.
      if (cannotFinishWhenHealthy(context, service)) continue;
      const budget = context.budgets.service(service);
      if (!exceeds(budget.maxQueueWaitMs + budget.healthyMs, budget.budgetMs)) continue;

      const capacity = context.system.services[service]?.queueCapacity ?? 0;
      const target = serviceTarget(service);
      findings.push({
        id: findingId('dead-on-arrival-queue', target),
        rule: 'dead-on-arrival-queue',
        severity: 'high',
        target,
        title:
          capacity === 'unbounded'
            ? `The ${service} queue is unbounded, but ${waitPhrase(waiter(context, service))}`
            : `A full ${service} queue holds ${formatDuration(budget.maxQueueWaitMs)} of work, but ${waitPhrase(waiter(context, service))}`,
        explanation:
          `A full queue of ${capacity === 'unbounded' ? 'unbounded length' : capacity} at ` +
          `${Math.round(budget.throughputPerMs * 1000)} requests/s${throughputOrigin(context, service)} means a wait of ` +
          `up to ${formatMs(budget.maxQueueWaitMs)}. With ${formatMs(budget.healthyMs)} of work after that, a request ` +
          `can need more than the ${formatMs(budget.budgetMs)} ${service} has (${budgetOrigin(context, service)}), ` +
          'so the service spends its capacity on requests whose caller is gone.',
        evidence: {
          queueCapacity: capacity,
          throughputPerSec: budget.throughputPerMs * 1000,
          maxQueueWaitMs: budget.maxQueueWaitMs,
          healthyMs: budget.healthyMs,
          budgetMs: budget.budgetMs,
        },
        mitigation: queueMitigation(service, capacity, budget),
      });
    }
    return findings;
  },
};

/** "the user waits 1000 ms", "orders waits 150 ms". */
function waitPhrase({ who, ms }: { who: string; ms: number }): string {
  return `${who} waits ${formatMs(ms)}`;
}

/**
 * Cap the queue so it drains within half of the time left after the work itself (there is some: the service
 * can finish when healthy). No safe change when the cap would not be smaller than today's queue.
 */
function queueMitigation(
  service: string,
  capacity: number | 'unbounded',
  budget: { throughputPerMs: number; budgetMs: number; healthyMs: number },
): Mitigation | null {
  const cap = Math.max(1, Math.floor(budget.throughputPerMs * (budget.budgetMs - budget.healthyMs) * QUEUE_HEADROOM));
  if (capacity !== 'unbounded' && cap >= capacity) return null;
  return {
    summary: `Cap the queue at ${cap}`,
    patches: [{ target: serviceTarget(service), field: 'queueCapacity', from: capacity, to: cap }],
  };
}
