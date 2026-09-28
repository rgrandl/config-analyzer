// Rule 4 (DESIGN.md §7): a service that ignores its caller's deadline keeps working on requests nobody is
// waiting for, and passes no deadline on, so its callees cannot drop stale work either.
import type { Finding } from '../finding';
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
        title: `${service} does not propagate deadlines`,
        explanation:
          `${service} ignores the time its caller will wait. It keeps serving and retrying requests whose caller has ` +
          'already given up, and its callees cannot tell which work is stale. After an overload, that stale work can ' +
          'keep the system saturated.',
        evidence: { deadlinePropagation: 'false' },
        mitigation: {
          summary: 'Propagate deadlines',
          patches: [{ target, field: 'deadlinePropagation', from: false, to: true }],
        },
      });
    }
    return findings;
  },
};
