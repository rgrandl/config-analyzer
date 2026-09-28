// Rule 4 (DESIGN.md §7): a service that ignores its caller's deadline keeps working on requests nobody is
// waiting for, and passes no deadline on, so its callees cannot drop stale work either.
import type { Finding } from '../finding';
import type { CallGraph } from '../../config/callGraph';
import type { SystemConfig } from '../../config/schema';
import { findingId, serviceTarget, type Rule } from './rule';

export const missingDeadlinePropagation: Rule = {
  id: 'missing-deadline-propagation',
  check({ system, graph }) {
    const findings: Finding[] = [];
    for (const service of graph.services) {
      if (system.services[service]?.deadlinePropagation !== false) continue;
      const target = serviceTarget(service);
      findings.push({
        id: findingId('missing-deadline-propagation', target),
        rule: 'missing-deadline-propagation',
        severity: 'medium',
        target,
        // A service without calls has nothing to pass a deadline on to: for it, the flag means dropping stale work.
        title:
          graph.callsOf(service).length > 0
            ? `${service} does not propagate deadlines`
            : `${service} ignores its callers' deadlines`,
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

/** Says only what applies: retries if the service makes retrying calls, callees if it has any. */
function explanation(system: SystemConfig, graph: CallGraph, service: string): string {
  const calls = graph.callsOf(service);
  const retries = calls.some((edge) => edge.config.maxAttempts > 1);
  const who = service === system.entry.service ? 'the user' : 'its caller';
  const work = retries ? 'serving and retrying' : 'serving';
  const callees =
    calls.length > 0 ? ', and it passes no deadline on, so its callees cannot tell which work is stale either' : '';
  return (
    `${service} ignores the time ${who} will wait. It keeps ${work} requests whose ${who === 'the user' ? 'user' : 'caller'} ` +
    `has already given up${callees}. After an overload, that stale work can keep the system saturated.`
  );
}
