// Rule 1 (DESIGN.md §7): retries at more than one layer of a path multiply. Only the deepest retrying
// layer should retry, since a retry there repeats the least work.
import type { CallEdge, CallGraph } from '../../config/callGraph';
import type { Finding } from '../finding';
import { listPhrase } from '../text';
import { callTarget, findingId, nameOf, type Rule } from './rule';

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
      // The service below that the most attempts can reach, per user request.
      const [deepestService, deepest] = below
        .map((call): [string, number] => [call.callee, attemptsPerRequest.get(call.callee) ?? 0])
        .reduce((best, next) => (next[1] > best[1] ? next : best));
      const name = nameOf(graph, edge);
      findings.push({
        id: findingId('retry-amplification', target),
        rule: 'retry-amplification',
        severity: 'high',
        target,
        title: `${name} retries multiply: up to ${deepest} ${deepestService} attempts per user request`,
        explanation:
          `${name} makes up to ${edge.config.maxAttempts} attempts, and ` +
          `${listPhrase(below.map((call) => nameOf(graph, call)))} below it retry too. Each layer's attempts ` +
          'repeat all the attempts below it. Keeping retries only at the deepest layer repeats the least work.',
        evidence: {
          maxAttempts: edge.config.maxAttempts,
          retryingBelow: below.map((call) => call.id).join(', '),
          worstAttemptsPerRequest: deepest,
        },
        mitigation: {
          summary: 'Make it a single attempt',
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
