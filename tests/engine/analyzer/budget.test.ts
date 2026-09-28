import { describe, expect, it } from 'vitest';
import {
  computeBudgets,
  effectiveBackoff,
  worstCaseMs,
} from '../../../src/engine/analyzer/budget';
import { DEFAULT_BACKOFF } from '../../../src/engine/analyzer/defaults';
import { call, demoSystem, service, system } from '../../helpers/fixtures';

describe('effectiveBackoff and worstCaseMs', () => {
  it('uses the default backoff for a call that retries without one', () => {
    // Plan: take a 3-attempt call with no backoff, as in the demo.
    // Verifies: it counts the default backoff (10 ms, then 20 ms), so 3 × 150 + 10 + 20 = 480 ms.
    const retrying = call('c', 'x', { timeoutMs: 150, maxAttempts: 3 });
    expect(effectiveBackoff(retrying)).toEqual(DEFAULT_BACKOFF);
    expect(worstCaseMs(retrying, 3, 150)).toBe(480);
  });

  it('keeps a configured backoff, capping delays at maxMs', () => {
    // Plan: take a 3-attempt call with backoff base 50 ms, ×4, max 100 ms.
    // Verifies: the delays are 50 ms then 100 ms (capped), so 3 × 100 + 150 = 450 ms.
    const backoff = { baseMs: 50, multiplier: 4, maxMs: 100, jitter: 'full' as const };
    const configured = call('c', 'x', { timeoutMs: 100, maxAttempts: 3, backoff });
    expect(effectiveBackoff(configured)).toBe(backoff);
    expect(worstCaseMs(configured, 3, 100)).toBe(450);
  });

  it('replaces only a zero base delay', () => {
    // Plan: take a retrying call whose backoff has baseMs 0 and multiplier 3.
    // Verifies: baseMs becomes the default 10 ms while the rest of its backoff is kept.
    const zeroBase = call('c', 'x', { maxAttempts: 2, backoff: { baseMs: 0, multiplier: 3, maxMs: 90, jitter: 'none' } });
    expect(effectiveBackoff(zeroBase)).toEqual({ baseMs: 10, multiplier: 3, maxMs: 90, jitter: 'none' });
  });

  it('raises maxMs with a zero base delay so the backoff stays valid', () => {
    // Plan: take a retrying call whose backoff is baseMs 0 and maxMs 0, which is valid but never waits.
    // Verifies: the effective backoff is baseMs 10 and maxMs 10, keeping maxMs ≥ baseMs.
    const zeros = call('c', 'x', { maxAttempts: 2, backoff: { baseMs: 0, multiplier: 2, maxMs: 0, jitter: 'full' } });
    expect(effectiveBackoff(zeros)).toMatchObject({ baseMs: 10, maxMs: 10 });
  });

  it('adds no backoff for a single attempt', () => {
    // Plan: take a 1-attempt call with no backoff.
    // Verifies: no backoff is assumed, and the worst case is just the timeout.
    const single = call('c', 'x', { timeoutMs: 100, maxAttempts: 1 });
    expect(effectiveBackoff(single)).toBeUndefined();
    expect(worstCaseMs(single, 1, 100)).toBe(100);
  });
});

describe('computeBudgets on the demo (DESIGN.md §11.2)', () => {
  const budgets = computeBudgets(demoSystem());

  it.each([
    // service, svcMax, healthy, meanHealthy, throughput (req/ms), budget, maxQueueWait
    ['api', 3, 46.5, 33, 0.2, 998, 5000],
    ['orders', 7.5, 41.5, 29, 0.2, 898, 5000],
    ['db', 15, 15, 10, 0.4, 148, 2500],
  ])('computes the service numbers of %s', (name, svcMax, healthy, meanHealthy, throughput, budget, maxWait) => {
    // Plan: compute budgets for the demo system.
    // Verifies: each service matches the table in DESIGN.md §11.2.
    const actual = budgets.service(name);
    expect(actual.svcMaxMs).toBeCloseTo(svcMax);
    expect(actual.healthyMs).toBeCloseTo(healthy);
    expect(actual.meanHealthyMs).toBeCloseTo(meanHealthy);
    expect(actual.throughputPerMs).toBeCloseTo(throughput);
    expect(actual.budgetMs).toBeCloseTo(budget);
    expect(actual.maxQueueWaitMs).toBeCloseTo(maxWait);
  });

  it.each([
    // call, elapsedBefore, share, worstCase, floor, window
    ['api.placeOrder', 3, 995, 2730, 87, 898],
    ['orders.readStock', 7.5, 856.5, 480, 34, 148],
    ['orders.writeOrder', 487.5, 410.5, 480, 34, 148],
  ])('computes the call numbers of %s', (id, elapsedBefore, share, worst, floor, window) => {
    // Plan: compute budgets for the demo system.
    // Verifies: each call matches DESIGN.md §6 and §11.2, including the order-aware split of orders' budget.
    const actual = budgets.call(id);
    expect(actual.elapsedBeforeMs).toBeCloseTo(elapsedBefore);
    expect(actual.shareMs).toBeCloseTo(share);
    expect(actual.worstCaseMs).toBeCloseTo(worst);
    expect(actual.floorMs).toBeCloseTo(floor);
    expect(actual.windowMs).toBeCloseTo(window);
  });

  it('records where each budget comes from', () => {
    // Plan: compute budgets for the demo system.
    // Verifies: api's budget comes from the user's deadline, orders' from the placeOrder timeout, and db's from
    //   the first of its two equally tight calls, readStock.
    expect(budgets.service('api').budgetSource).toEqual({ kind: 'deadline', deadlineMs: 1000 });
    expect(budgets.service('orders').budgetSource).toEqual({
      kind: 'call', caller: 'api', call: 'placeOrder', limitedBy: 'timeout', limitMs: 900,
    });
    expect(budgets.service('db').budgetSource).toMatchObject({ caller: 'orders', call: 'readStock', limitedBy: 'timeout' });
  });

  it('records which service limits throughput', () => {
    // Plan: compute budgets for the demo system.
    // Verifies: db is limited by its own workers; orders and api by db, at 2 calls to db per request.
    const limitedByDb = { kind: 'downstream', bottleneck: 'db', callsPerRequest: 2 };
    expect(budgets.service('db').throughputLimit).toEqual({ kind: 'workers' });
    expect(budgets.service('orders').throughputLimit).toMatchObject(limitedByDb);
    expect(budgets.service('api').throughputLimit).toMatchObject(limitedByDb);
  });

  it('limits a callee by the time its caller has left, not by the timeout', () => {
    // Plan: raise the demo's placeOrder timeout to 1200 ms, beyond the 995 ms api has for that call.
    // Verifies: orders gets min(1200, 995) − 2 = 993 ms, not 1198 ms.
    const demo = demoSystem();
    const placeOrder = demo.services.api?.calls[0];
    if (placeOrder) placeOrder.timeoutMs = 1200;
    expect(computeBudgets(demo).service('orders').budgetMs).toBeCloseTo(993);
  });
});

describe('computeBudgets allocation rules', () => {
  // Entry S (10 ms of local work) makes two sequential calls to A and B; A and B take 10 ms, so each
  // call's floor is 2 × 10 = 20 ms. The network latency is 0 and the deadline is 1000 ms.
  function twoCalls(first: { timeoutMs: number; maxAttempts: number }, second: { timeoutMs: number }) {
    return system({
      s: service({ calls: [call('first', 'a', first), call('second', 'b', { ...second, maxAttempts: 1 })] }),
      a: service(),
      b: service(),
    });
  }

  it('lets slack from a fast first call flow to a later call', () => {
    // Plan: a fast first call (50 ms) followed by a slow one (800 ms).
    // Verifies: the second call's share is 1000 − 10 − 50 = 940 ms, so its 800 ms fits.
    //   A fixed split would have given each call about 495 ms and flagged the second.
    const budgets = computeBudgets(twoCalls({ timeoutMs: 50, maxAttempts: 1 }, { timeoutMs: 800 }));
    expect(budgets.call('s.first').shareMs).toBe(970);
    expect(budgets.call('s.second').shareMs).toBe(940);
  });

  it('keeps the floor of later calls even when an earlier call overruns', () => {
    // Plan: a first call whose 3 × 900 ms attempts far exceed its share.
    // Verifies: the first call counts only at its share (970 ms), so the second call keeps exactly its
    //   20 ms floor instead of going negative, and a second call of 20 ms is not pushed into overrun.
    const budgets = computeBudgets(twoCalls({ timeoutMs: 900, maxAttempts: 3 }, { timeoutMs: 20 }));
    expect(budgets.call('s.first').worstCaseMs).toBeGreaterThan(budgets.call('s.first').shareMs);
    expect(budgets.call('s.second').shareMs).toBe(budgets.call('s.second').floorMs);
    expect(budgets.call('s.second').worstCaseMs).toBeLessThanOrEqual(budgets.call('s.second').shareMs);
  });

  it('limits throughput by callees, per call made', () => {
    // Plan: S (many workers) calls C twice per request; C completes 0.1 requests/ms.
    // Verifies: S can complete at most 0.1 / 2 = 0.05 requests/ms.
    const budgets = computeBudgets(
      system({
        s: service({ workers: 1000, calls: [call('one', 'c'), call('two', 'c')] }),
        c: service({ workers: 1, serviceTimeMs: 10 }),
      }),
    );
    expect(budgets.service('c').throughputPerMs).toBeCloseTo(0.1);
    expect(budgets.service('s').throughputPerMs).toBeCloseTo(0.05);
    expect(budgets.service('s').throughputLimit).toEqual({ kind: 'downstream', bottleneck: 'c', callsPerRequest: 2, bottleneckPerMs: 0.1 });
  });

  it('treats an unbounded queue as an infinite wait', () => {
    // Plan: give the only service an unbounded queue.
    // Verifies: its worst-case queue wait is Infinity.
    const budgets = computeBudgets(system({ s: service({ queueCapacity: 'unbounded' }) }));
    expect(budgets.service('s').maxQueueWaitMs).toBe(Infinity);
  });

  it('clamps budgets at zero when local work alone exceeds the deadline', () => {
    // Plan: the entry's local work (1500 ms) exceeds the 1000 ms deadline, and it calls A.
    // Verifies: the call's share is negative (reported later by the rules), and A's budget is 0, not negative.
    const budgets = computeBudgets(
      system({ s: service({ serviceTimeMs: 1500, calls: [call('toA', 'a')] }), a: service() }),
    );
    expect(budgets.call('s.toA').shareMs).toBeLessThan(0);
    expect(budgets.service('a').budgetMs).toBe(0);
  });

  it('raises the floor to the observed p99 and applies the multiplier', () => {
    // Plan: A is healthy at 10 ms but has an observed p99 of 100 ms; use multipliers 2 and 3.
    // Verifies: the floor is multiplier × max(10, 100): 200 ms and 300 ms.
    const withP99 = system({ s: service({ calls: [call('toA', 'a')] }), a: service({ observedP99Ms: 100 }) });
    expect(computeBudgets(withP99).call('s.toA').floorMs).toBe(200);
    expect(computeBudgets(withP99, { timeoutFloorMultiplier: 3 }).call('s.toA').floorMs).toBe(300);
  });

  it('gives a callee the smallest window among its callers', () => {
    // Plan: entry S calls A and B; both call C, with timeouts of 300 ms and 100 ms.
    // Verifies: C's budget is the smaller window, 100 ms (the network latency is 0), not 300 ms.
    const budgets = computeBudgets(
      system({
        s: service({ calls: [call('toA', 'a', { timeoutMs: 450 }), call('toB', 'b', { timeoutMs: 450 })] }),
        a: service({ calls: [call('toC', 'c', { timeoutMs: 300 })] }),
        b: service({ calls: [call('toC', 'c', { timeoutMs: 100 })] }),
        c: service(),
      }),
    );
    expect(budgets.call('a.toC').windowMs).toBe(300);
    expect(budgets.call('b.toC').windowMs).toBe(100);
    expect(budgets.service('c').budgetMs).toBe(100);
    expect(budgets.service('c').budgetSource).toMatchObject({ caller: 'b', call: 'toC' });
  });

  it('limits a window by the share when the timeout is longer', () => {
    // Plan: entry S (1000 ms budget, 10 ms local work) calls A with a 2000 ms timeout, over 1 ms links.
    // Verifies: the share is 1000 − 2 − 10 = 988 ms, so A's window is 988 − 2 = 986 ms, not 2000 − 2.
    const budgets = computeBudgets(
      system({ s: service({ calls: [call('toA', 'a', { timeoutMs: 2000 })] }), a: service() }, { networkLatencyMs: 1 }),
    );
    expect(budgets.call('s.toA').shareMs).toBe(988);
    expect(budgets.call('s.toA').windowMs).toBe(986);
    expect(budgets.service('a').budgetMs).toBe(986);
    expect(budgets.service('a').budgetSource).toEqual({ kind: 'call', caller: 's', call: 'toA', limitedBy: 'share', limitMs: 988 });
  });

  it('exposes the time left for calls after local work', () => {
    // Plan: take the demo's orders service (898 ms budget, 7.5 ms worst-case local work).
    // Verifies: availableMs = budget − svcMax = 890.5 ms, the value the degenerate-case rule uses.
    expect(computeBudgets(demoSystem()).service('orders').availableMs).toBeCloseTo(890.5);
  });

  it('only grows later shares when an earlier call is brought within its share', () => {
    // Plan: compute a service whose first call overruns (3 × 900 ms), then the same service with the
    //   first call reduced to one 900 ms attempt, as a mitigation would do.
    // Verifies: the second call's share does not shrink, so fixing one call cannot create an overrun in the next.
    const before = computeBudgets(twoCalls({ timeoutMs: 900, maxAttempts: 3 }, { timeoutMs: 20 }));
    const after = computeBudgets(twoCalls({ timeoutMs: 900, maxAttempts: 1 }, { timeoutMs: 20 }));
    expect(after.call('s.second').shareMs).toBeGreaterThanOrEqual(before.call('s.second').shareMs);
  });

  it('refuses a service without callers, which only an unvalidated config can have', () => {
    // Plan: compute budgets for a system with a second, unreachable service.
    // Verifies: a clear error instead of an infinite budget.
    expect(() => computeBudgets(system({ s: service(), orphan: service() }))).toThrow(/no callers/);
  });
});
