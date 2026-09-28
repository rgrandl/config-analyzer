// Rule 4 (DESIGN.md §7): a service that ignores its caller's deadline keeps working on requests nobody is
// waiting for, and passes no deadline on, so its callees cannot drop stale work either.
import type { Finding } from '../finding';
import type { CallGraph } from '../../config/callGraph';
import type { SystemConfig } from '../../config/schema';
import { formatMs } from '../text';
import { findingId, serviceTarget, waiter, type Rule, type RuleContext } from './rule';

export const missingDeadlinePropagation: Rule = {
  id: 'missing-deadline-propagation',
  check(context) {
    const { system, graph } = context;
    const findings: Finding[] = [];
    for (const service of graph.services) {
      if (system.services[service]?.deadlinePropagation !== false) continue;
      const target = serviceTarget(service);
      findings.push({
        id: findingId('missing-deadline-propagation', target),
        rule: 'missing-deadline-propagation',
        severity: 'medium',
        target,
        title: title(context, service),
        explanation: explanation(system, graph, service),
        evidence: { deadlinePropagation: 'false' },
        mitigation: {
          summary: graph.callsOf(service).length > 0 ? 'Propagate deadlines' : "Honor its callers' deadlines",
          patches: [{ target, field: 'deadlinePropagation', from: false, to: true }],
        },
      });
    }
    return findings;
  },
};

/** "api keeps working after the user's 1000 ms deadline", "db keeps working after orders stops waiting (150 ms)". */
function title(context: RuleContext, service: string): string {
  const { who, ms } = waiter(context, service);
  return who === 'the user'
    ? `${service} keeps working after the user's ${formatMs(ms)} deadline`
    : `${service} keeps working after ${who} stops waiting (${formatMs(ms)})`;
}

/**
 * Says only what applies: retries if the service makes retrying calls, callees if it has any. A service
 * without calls has nothing to pass a deadline on to; for it, the flag means dropping stale work.
 */
function explanation(system: SystemConfig, graph: CallGraph, service: string): string {
  const calls = graph.callsOf(service);
  const retries = calls.some((edge) => edge.config.maxAttempts > 1);
  const who = service === system.entry.service ? 'the user' : 'its caller';
  const work = retries ? 'serving and retrying' : 'serving';
  const callees =
    calls.length > 0 ? '. It passes no deadline on, so its callees cannot tell which work is stale either' : '';
  return (
    `It ignores the time ${who} will wait and keeps ${work} requests after ${who} has given up${callees}. After an overload, that stale work can keep the system saturated.`
  );
}
