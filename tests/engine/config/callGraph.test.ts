import { describe, expect, it } from 'vitest';
import { CallGraph, callId } from '../../../src/engine/config/callGraph';
import { call, demoSystem, service } from '../../helpers/fixtures';

describe('CallGraph', () => {
  const demo = new CallGraph(demoSystem().services);

  it('lists outgoing calls in execution order and incoming calls per service', () => {
    // Plan: build the graph of the demo system.
    // Verifies: orders' calls come in declared order, and db has both of them as callers.
    expect(demo.callsOf('orders').map((edge) => edge.id)).toEqual(['orders.readStock', 'orders.writeOrder']);
    expect(demo.callersOf('db').map((edge) => edge.id)).toEqual(['orders.readStock', 'orders.writeOrder']);
    expect(demo.callersOf('api')).toEqual([]);
  });

  it('orders services callers first', () => {
    // Plan: take the topological order of the demo, and of a diamond a → {b, c} → d.
    // Verifies: every service appears after all of its callers.
    expect(demo.topologicalOrder()).toEqual(['api', 'orders', 'db']);

    const diamond = new CallGraph({
      a: service({ calls: [call('toB', 'b'), call('toC', 'c')] }),
      b: service({ calls: [call('toD', 'd')] }),
      c: service({ calls: [call('toD', 'd')] }),
      d: service(),
    });
    const order = diamond.topologicalOrder();
    expect(order.indexOf('a')).toBe(0);
    expect(order.indexOf('d')).toBe(3);
  });

  it('finds reachable services', () => {
    // Plan: ask what the demo's api and db can reach.
    // Verifies: api reaches orders and db (not itself); db reaches nothing.
    expect(demo.reachableFrom('api')).toEqual(new Set(['orders', 'db']));
    expect(demo.reachableFrom('db')).toEqual(new Set());
  });

  it('detects a cycle and refuses to order it', () => {
    // Plan: build a → b → c → b.
    // Verifies: the cycle is reported as b → c → b, and topologicalOrder throws.
    const cyclic = new CallGraph({
      a: service({ calls: [call('toB', 'b')] }),
      b: service({ calls: [call('toC', 'c')] }),
      c: service({ calls: [call('toB', 'b')] }),
    });
    expect(cyclic.findCycle()).toEqual(['b', 'c', 'b']);
    expect(() => cyclic.topologicalOrder()).toThrow(/cycle/);
    expect(demo.findCycle()).toBeUndefined();
  });

  it('rejects a call to an unknown service at construction', () => {
    // Plan: build a graph where a calls a service that does not exist.
    // Verifies: construction throws, since validation must catch this before a graph is built.
    expect(() => new CallGraph({ a: service({ calls: [call('toX', 'x')] }) })).toThrow(/unknown service "x"/);
  });

  it('formats call ids as caller.name', () => {
    // Plan: build an id for orders' readStock call.
    // Verifies: the id format used across findings and budgets.
    expect(callId('orders', 'readStock')).toBe('orders.readStock');
  });
});
