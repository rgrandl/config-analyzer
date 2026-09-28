// Rule 1 (DESIGN.md §7): retries at more than one layer of a path multiply. Only the deepest retrying
// layer should retry, since a retry there repeats the least work.
import type { CallEdge, CallGraph } from '../../config/callGraph';
import type { Finding } from '../finding';
import { callTarget, describeCall, findingId, type Rule } from './rule';

export const retryAmplification: Rule = {
  id: 'retry-amplification',
  check({ system, graph }) {
    const attemptsPerRequest = worstAttemptsPerRequest(graph, system.entry.service);
    const findings: Finding[] = [];

    for (const edge of graph.calls) {
      if (edge.config.maxAttempts <= 1) continue;
      const below = retryingCallsBelow(graph, edge);
      if (below.length === 0) continue;

      const target = callTarget(edge);
      const deepest = Math.max(...below.map((call) => attemptsPerRequest.get(call.callee) ?? 0));
      findings.push({
        id: findingId('retry-amplification', target),
        rule: 'retry-amplification',
        severity: 'high',
        target,
        title: `${describeCall(edge)} retries, and so do calls below it`,
        explanation:
          `${describeCall(edge)} makes up to ${edge.config.maxAttempts} attempts, and ` +
          `${below.map((call) => call.id).join(', ')} below it retry too. Retries multiply across layers: ` +
          `one user request can cause up to ${deepest} attempts at the deepest service. ` +
          'Keeping retries only at the deepest layer repeats the least work.',
        evidence: {
          maxAttempts: edge.config.maxAttempts,
          retryingBelow: below.map((call) => call.id).join(', '),
          worstAttemptsPerRequest: deepest,
        },
        mitigation: {
          summary: `Make ${describeCall(edge)} a single attempt`,
          patches: [{ target, field: 'maxAttempts', from: edge.config.maxAttempts, to: 1 }],
        },
      });
    }
    return findings;
  },
};

/** Retrying calls made by the callee of `edge` or by any service below it. */
function retryingCallsBelow(graph: CallGraph, edge: CallEdge): CallEdge[] {
  const services = [edge.callee, ...graph.reachableFrom(edge.callee)];
  return services.flatMap((service) => graph.callsOf(service).filter((call) => call.config.maxAttempts > 1));
}

/**
 * Worst-case attempts each service receives per end-user request, if every attempt fails and is retried:
 * the entry gets 1, and each call multiplies its caller's count by its maxAttempts.
 */
export function worstAttemptsPerRequest(graph: CallGraph, entry: string): Map<string, number> {
  const attempts = new Map<string, number>([[entry, 1]]);
  for (const service of graph.topologicalOrder()) {
    const own = attempts.get(service) ?? 0;
    for (const edge of graph.callsOf(service)) {
      attempts.set(edge.callee, (attempts.get(edge.callee) ?? 0) + own * edge.config.maxAttempts);
    }
  }
  return attempts;
}
