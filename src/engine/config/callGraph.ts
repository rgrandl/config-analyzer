// The call graph: services as nodes, calls as edges. It is a view over a SystemConfig, shared by
// validation (cycles, reachability), the analyzer (budgets, rules) and later the simulator.
import type { CallConfig, ServiceConfig } from './schema';

/** Identifies a call as "<caller>.<call name>", e.g. "orders.readStock". */
export type CallId = string;

export function callId(caller: string, callName: string): CallId {
  return `${caller}.${callName}`;
}

export interface CallEdge {
  readonly id: CallId;
  readonly caller: string;
  readonly callee: string;
  /** Position in the caller's call list; calls run in this order. */
  readonly index: number;
  readonly config: CallConfig;
}

/** The part of a service the graph needs, so tests can build graphs from minimal data. */
export type ServiceCalls = Pick<ServiceConfig, 'calls'>;

export class CallGraph {
  private readonly outgoing = new Map<string, CallEdge[]>();
  private readonly incoming = new Map<string, CallEdge[]>();

  /** Every call's `to` must name a service in `services`; validation guarantees this before building a graph. */
  constructor(services: Readonly<Record<string, ServiceCalls>>) {
    for (const name of Object.keys(services)) {
      this.outgoing.set(name, []);
      this.incoming.set(name, []);
    }
    for (const [caller, service] of Object.entries(services)) {
      service.calls.forEach((config, index) => {
        const callees = this.incoming.get(config.to);
        if (!callees) throw new Error(`Call ${callId(caller, config.name)} targets unknown service "${config.to}"`);
        const edge: CallEdge = { id: callId(caller, config.name), caller, callee: config.to, index, config };
        this.outgoing.get(caller)?.push(edge);
        callees.push(edge);
      });
    }
  }

  /** Service names in declaration order. */
  get services(): readonly string[] {
    return [...this.outgoing.keys()];
  }

  /** Outgoing calls of a service, in execution order. */
  callsOf(service: string): readonly CallEdge[] {
    return this.outgoing.get(service) ?? [];
  }

  /** Incoming calls of a service. */
  callersOf(service: string): readonly CallEdge[] {
    return this.incoming.get(service) ?? [];
  }

  /** A cycle as a list of services that starts and ends with the same one, e.g. ["a", "b", "a"]; undefined if acyclic. */
  findCycle(): string[] | undefined {
    const state = new Map<string, 'visiting' | 'done'>();
    const stack: string[] = [];

    const visit = (service: string): string[] | undefined => {
      state.set(service, 'visiting');
      stack.push(service);
      for (const edge of this.callsOf(service)) {
        const seen = state.get(edge.callee);
        if (seen === 'visiting') return [...stack.slice(stack.indexOf(edge.callee)), edge.callee];
        if (seen === undefined) {
          const cycle = visit(edge.callee);
          if (cycle) return cycle;
        }
      }
      stack.pop();
      state.set(service, 'done');
      return undefined;
    };

    for (const service of this.services) {
      if (state.has(service)) continue;
      const cycle = visit(service);
      if (cycle) return cycle;
    }
    return undefined;
  }

  /** Callers before callees, deterministic for a given config. Throws if the graph has a cycle. */
  topologicalOrder(): string[] {
    const cycle = this.findCycle();
    if (cycle) throw new Error(`Call graph has a cycle: ${cycle.join(' → ')}`);

    const done = new Set<string>();
    const postOrder: string[] = [];
    const visit = (service: string): void => {
      if (done.has(service)) return;
      done.add(service);
      for (const edge of this.callsOf(service)) visit(edge.callee);
      postOrder.push(service);
    };
    for (const service of this.services) visit(service);
    return postOrder.reverse();
  }

  /** Services reachable from `service` through one or more calls (not including itself unless in a cycle). */
  reachableFrom(service: string): Set<string> {
    const reached = new Set<string>();
    const pending = this.callsOf(service).map((edge) => edge.callee);
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      if (reached.has(next)) continue;
      reached.add(next);
      pending.push(...this.callsOf(next).map((edge) => edge.callee));
    }
    return reached;
  }
}
