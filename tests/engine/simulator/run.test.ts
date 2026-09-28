import { describe, expect, it } from 'vitest';
import { analyze } from '../../../src/engine/analyzer/analyze';
import { computeBudgets } from '../../../src/engine/analyzer/budget';
import { applyMitigations } from '../../../src/engine/analyzer/mitigation/applyMitigations';
import type { SystemConfig } from '../../../src/engine/config/schema';
import { poissonArrivals } from '../../../src/engine/simulator/arrivals';
import { createSimulator, simulator } from '../../../src/engine/simulator/run';
import type { RunResult } from '../../../src/engine/simulator/types';
import { call, demoScenario, demoSystem, scenario, service, system, total } from '../../helpers/fixtures';

// Hand-made systems use 1 ms links and no jitter, so every time below can be worked out by hand:
// user → s: 1 ms, s's work, s → a: 1 ms, a's work, a → s: 1 ms, s → user: 1 ms.
const withLinks = (services: SystemConfig['services'], deadlineMs = 1000): SystemConfig =>
  system(services, { networkLatencyMs: 1, entry: { service: 's', deadlineMs } });

function run(config: SystemConfig, arrivals: number[], overrides: Parameters<typeof scenario>[0] = {}): RunResult {
  return simulator.run(config, scenario(overrides), arrivals);
}

const sum = (result: RunResult, service: string, field: 'firstAttemptArrivals' | 'retryArrivals' | 'rejections' | 'expiredDrops' | 'completions') =>
  total(result.buckets, (b) => b.services[service]?.[field] ?? 0);
const sumCall = (result: RunResult, id: string, field: 'attempts' | 'retries' | 'timeouts' | 'failures') =>
  total(result.buckets, (b) => b.calls[id]?.[field] ?? 0);
const latencies = (result: RunResult) => result.requests.map((r) => (r.completionMs ?? NaN) - r.arrivalMs);

describe('simulator: request flow', () => {
  it('serves requests at exactly the healthy latency under low load', () => {
    // Plan: s (5 ms) calls a (10 ms); three requests 100 ms apart, so nothing ever queues.
    // Verifies: each succeeds after 1 + 5 + 1 + 10 + 1 + 1 = 19 ms, which is also the analyzer's healthy(s) + rtt.
    const config = withLinks({ s: service({ serviceTimeMs: 5, calls: [call('toA', 'a')] }), a: service() });
    const result = run(config, [0, 100, 200]);
    expect(latencies(result)).toEqual([19, 19, 19]);
    expect(result.requests.every((r) => r.ok)).toBe(true);
    const budgets = computeBudgets(config);
    expect(budgets.service('s').healthyMs + budgets.rttMs).toBe(19);
  });

  it('retries a callee that is always slower than the timeout, then fails the request', () => {
    // Plan: s calls a with a 20 ms timeout and 3 attempts, but a takes 50 ms; one request.
    // Verifies: 3 attempts, 3 timeouts, 1 call failure, the user sees a failure, and all of a's work is wasted.
    const config = withLinks({
      s: service({ calls: [call('toA', 'a', { timeoutMs: 20, maxAttempts: 3 })] }),
      a: service({ serviceTimeMs: 50 }),
    });
    const result = run(config, [0]);
    expect([sumCall(result, 's.toA', 'attempts'), sumCall(result, 's.toA', 'timeouts'), sumCall(result, 's.toA', 'failures')]).toEqual([3, 3, 1]);
    expect(result.requests[0]?.ok).toBe(false);
    expect(total(result.buckets, (b) => b.failures)).toBe(1);
    const wasted = result.buckets.filter((b) => (b.services.a?.utilization ?? 0) > 0).map((b) => b.services.a?.wastedFraction);
    expect(wasted.every((fraction) => fraction === 1)).toBe(true);
  });

  it('counts a response that arrives exactly at the timeout as a timeout', () => {
    // Plan: s calls a (10 ms); the response returns 1 + 10 + 1 = 12 ms after sending. Try timeouts of 12 and 13 ms.
    // Verifies: with 12 ms the attempt times out and the request fails; with 13 ms it succeeds.
    const withTimeout = (timeoutMs: number) =>
      withLinks({ s: service({ calls: [call('toA', 'a', { timeoutMs })] }), a: service() });
    const exact = run(withTimeout(12), [0]);
    const later = run(withTimeout(13), [0]);
    expect([sumCall(exact, 's.toA', 'timeouts'), exact.requests[0]?.ok]).toEqual([1, false]);
    expect([sumCall(later, 's.toA', 'timeouts'), later.requests[0]?.ok]).toEqual([0, true]);
  });

  it('handles two sequential calls, giving the second only the time left', () => {
    // Plan: s (10 ms, propagating a 60 ms user deadline, so it must finish by 59 ms) calls a (10 ms), then b.
    //   With a fast b (10 ms), the request takes 1 + 10 + 12 + 12 + 1 = 36 ms, the analyzer's healthy(s) + rtt.
    //   With a slow b (50 ms), a answers at 23 ms, so b's attempt gets min(100, 59 − 23) = 36 ms and times out
    //   at 59 ms.
    // Verifies: 36 ms in the fast case; in the slow case one timeout on b and a failed request at 60 ms,
    //   instead of waiting b's full 100 ms timeout.
    const config = (bMs: number) =>
      withLinks(
        {
          s: service({ deadlinePropagation: true, calls: [call('toA', 'a'), call('toB', 'b')] }),
          a: service(),
          b: service({ serviceTimeMs: bMs }),
        },
        60,
      );
    const fast = run(config(10), [0]);
    expect(latencies(fast)).toEqual([36]);
    expect(computeBudgets(config(10)).service('s').healthyMs + 2).toBe(36);

    const slow = run(config(50), [0]);
    expect(sumCall(slow, 's.toB', 'timeouts')).toBe(1);
    expect(slow.requests[0]).toEqual({ arrivalMs: 0, completionMs: 60, ok: false });
  });

  it('counts a failure that arrives after the deadline as a failure, not a late success', () => {
    // Plan: a 30 ms deadline; s calls a, which always errors after 40 ms of work.
    // Verifies: the failure reaches the user at 54 ms and is counted once, as a failure.
    const config = withLinks({ s: service({ calls: [call('toA', 'a')] }), a: service({ serviceTimeMs: 40 }) }, 30);
    const result = run(config, [0], { faults: [{ service: 'a', startMs: 0, endMs: 10_000, errorRate: 1 }] });
    expect(result.requests[0]).toEqual({ arrivalMs: 0, completionMs: 54, ok: false });
    expect([total(result.buckets, (b) => b.failures), total(result.buckets, (b) => b.lateSuccesses)]).toEqual([1, 0]);
  });

  it('finishes when rejections and retries happen at the same instant over zero-latency links', () => {
    // Plan: zero network latency; five requests at once to s, which calls a (one worker, no queue, 100 ms)
    //   with 3 attempts and no backoff, so rejected attempts are retried instantly.
    // Verifies: the run ends, a serves 1 job and rejects the rest (4 requests × 3 attempts = 12 rejections),
    //   and every arrival at a is accounted for.
    const config = system({
      s: service({ calls: [call('toA', 'a', { timeoutMs: 200, maxAttempts: 3 })] }),
      a: service({ workers: 1, queueCapacity: 0, serviceTimeMs: 100 }),
    });
    const result = run(config, [0, 0, 0, 0, 0]);
    expect([sum(result, 'a', 'completions'), sum(result, 'a', 'rejections')]).toEqual([1, 12]);
    expect(sum(result, 'a', 'firstAttemptArrivals') + sum(result, 'a', 'retryArrivals')).toBe(13);
  });

  it('reports a success after the user gave up as late, not as goodput', () => {
    // Plan: a 30 ms deadline, but s alone takes 50 ms.
    // Verifies: the response arrives at 52 ms, the request is not ok, and it counts as a late success.
    const result = run(withLinks({ s: service({ serviceTimeMs: 50 }) }, 30), [0]);
    expect(result.requests[0]).toEqual({ arrivalMs: 0, completionMs: 52, ok: false });
    expect([total(result.buckets, (b) => b.goodput), total(result.buckets, (b) => b.lateSuccesses)]).toEqual([0, 1]);
  });
});

describe('simulator: queues and deadlines', () => {
  // Five requests at once; s (10 ms of work) calls a, which has one worker, 100 ms of work and a
  // 150 ms timeout. The attempts reach a at 12 ms, carrying the deadline 11 + 150 − 1 = 160 ms.
  const burst = [0, 0, 0, 0, 0];
  const busyCallee = (deadlinePropagation: boolean, queueCapacity: number | 'unbounded' = 'unbounded') =>
    withLinks({
      s: service({ calls: [call('toA', 'a', { timeoutMs: 150 })] }),
      a: service({ workers: 1, queueCapacity, serviceTimeMs: 100, deadlinePropagation }),
    });

  it('drops expired queued work for free when the callee propagates deadlines', () => {
    // Plan: run the burst without and with deadline propagation at a.
    // Verifies: without it, a serves all 5 jobs; with it, a serves 2 (started at 12 and 112 ms) and drops the
    //   3 that would start after 160 ms, doing 300 ms less work.
    const without = run(busyCallee(false), burst);
    const withPropagation = run(busyCallee(true), burst);
    expect([sum(without, 'a', 'completions'), sum(without, 'a', 'expiredDrops')]).toEqual([5, 0]);
    expect([sum(withPropagation, 'a', 'completions'), sum(withPropagation, 'a', 'expiredDrops')]).toEqual([2, 3]);
  });

  it('drops a job exactly at its carried deadline, which leaves room for the return hop', () => {
    // Plan: with a 102 ms timeout, the carried deadline is 11 + 102 − 1 = 112 ms, exactly when a's second job
    //   would start; with 103 ms it is 113 ms.
    // Verifies: at 102 ms only the first job runs (1 completion, 4 drops); at 103 ms the second one starts too
    //   (2 completions). Without the "− 1 hop", both timeouts would run two jobs.
    const withTimeout = (timeoutMs: number) =>
      withLinks({
        s: service({ calls: [call('toA', 'a', { timeoutMs })] }),
        a: service({ workers: 1, queueCapacity: 'unbounded', serviceTimeMs: 100, deadlinePropagation: true }),
      });
    const tight = run(withTimeout(102), burst);
    const roomy = run(withTimeout(103), burst);
    expect([sum(tight, 'a', 'completions'), sum(tight, 'a', 'expiredDrops')]).toEqual([1, 4]);
    expect([sum(roomy, 'a', 'completions'), sum(roomy, 'a', 'expiredDrops')]).toEqual([2, 3]);
  });

  it('stops retrying at the deadline and shortens the last attempt to the time left', () => {
    // Plan: s propagates a 60 ms user deadline (so it must finish by 59 ms). It calls a (50 ms) with a 20 ms
    //   timeout and 5 attempts, starting at 11 ms. Attempts start at 11, 31 and 51 ms; the third has only 8 ms.
    // Verifies: 3 attempts with deadline propagation, all 5 without it.
    const config = (deadlinePropagation: boolean) =>
      withLinks(
        {
          s: service({ deadlinePropagation, calls: [call('toA', 'a', { timeoutMs: 20, maxAttempts: 5 })] }),
          a: service({ serviceTimeMs: 50 }),
        },
        60,
      );
    expect(sumCall(run(config(true), [0]), 's.toA', 'attempts')).toBe(3);
    expect(sumCall(run(config(false), [0]), 's.toA', 'attempts')).toBe(5);
  });

  it('does not start a retry whose backoff ends after the deadline', () => {
    // Plan: s propagates a 40 ms user deadline (must finish by 39 ms). Its first attempt to a fails at 14 ms
    //   (a always errors), and the 50 ms backoff ends at 64 ms, past the deadline.
    // Verifies: the retry is never scheduled (1 attempt), the call fails right away at 14 ms instead of holding
    //   s's worker until 64 ms, and the user hears back at 15 ms, before the deadline.
    const config = withLinks(
      {
        s: service({
          deadlinePropagation: true,
          calls: [call('toA', 'a', { maxAttempts: 3, backoff: { baseMs: 50, multiplier: 1, maxMs: 50, jitter: 'none' } })],
        }),
        a: service({ serviceTimeMs: 1 }),
      },
      40,
    );
    const result = run(config, [0], { faults: [{ service: 'a', startMs: 0, endMs: 10_000, errorRate: 1 }] });
    expect([sumCall(result, 's.toA', 'attempts'), sumCall(result, 's.toA', 'failures')]).toEqual([1, 1]);
    expect(result.requests[0]).toEqual({ arrivalMs: 0, completionMs: 15, ok: false });
  });

  it('rejects immediately when the queue is full', () => {
    // Plan: the same burst, but a has no queue at all.
    // Verifies: a serves 1 job and rejects the other 4, which fail without waiting for the timeout.
    const result = run(busyCallee(false, 0), burst);
    expect([sum(result, 'a', 'completions'), sum(result, 'a', 'rejections')]).toEqual([1, 4]);
    expect(latencies(result).filter((latency) => latency < 20)).toHaveLength(4);
  });

  it('stops retrying when the retry budget runs out', () => {
    // Plan: a always fails (error rate 1); s.toA allows 5 attempts with a budget of ratio 0.1 and 2 tokens.
    //   Four requests, 1 s apart.
    // Verifies: the first request retries twice (spending both tokens), and the next three get only 0.1, 0.2
    //   and 0.3 tokens, so they cannot retry: 2 retries and 6 attempts in total.
    const config = withLinks({
      s: service({ calls: [call('toA', 'a', { maxAttempts: 5, retryBudget: { ratio: 0.1, maxTokens: 2 } })] }),
      a: service(),
    });
    const result = run(config, [0, 1000, 2000, 3000], { faults: [{ service: 'a', startMs: 0, endMs: 10_000, errorRate: 1 }] });
    expect([sumCall(result, 's.toA', 'retries'), sumCall(result, 's.toA', 'attempts')]).toEqual([2, 6]);
  });

  it('grants the retry that ten first attempts of 0.1 tokens pay for', () => {
    // Plan: a always fails; s.toA allows 2 attempts with a budget of ratio 0.1 and 1 token. Twelve requests,
    //   1 s apart: the first spends the initial token, the next ten earn 0.1 each, the last earns 0.1 more.
    // Verifies: 2 retries in total (the first request's, and the 11th request's paid by ten × 0.1), even though
    //   floating point adds those ten steps up to slightly less than 1.
    const config = withLinks({
      s: service({ calls: [call('toA', 'a', { maxAttempts: 2, retryBudget: { ratio: 0.1, maxTokens: 1 } })] }),
      a: service(),
    });
    const arrivals = Array.from({ length: 12 }, (_, i) => i * 1000);
    const result = run(config, arrivals, { durationMs: 15_000, faults: [{ service: 'a', startMs: 0, endMs: 15_000, errorRate: 1 }] });
    expect(sumCall(result, 's.toA', 'retries')).toBe(2);
  });

  it('earns retry tokens on first attempts only', () => {
    // Plan: one request to an always-failing a with 5 attempts and a budget of ratio 1 and 1 token.
    // Verifies: exactly 1 retry: the first attempt earns (capped at 1), the retry spends it, and the retry
    //   itself earns nothing. If retries earned tokens too, it would retry 4 times.
    const config = withLinks({
      s: service({ calls: [call('toA', 'a', { maxAttempts: 5, retryBudget: { ratio: 1, maxTokens: 1 } })] }),
      a: service(),
    });
    const result = run(config, [0], { faults: [{ service: 'a', startMs: 0, endMs: 10_000, errorRate: 1 }] });
    expect(sumCall(result, 's.toA', 'retries')).toBe(1);
  });

  it('slows only the work that starts inside a fault window', () => {
    // Plan: a (10 ms) is 5× slower from 1000 to 2000 ms; requests arrive at 500, 1500 and 2500 ms.
    // Verifies: latencies of 1 + 10 + 1 + 10 + 1 + 1 = 24 ms outside the window and 64 ms inside it.
    const config = withLinks({ s: service({ calls: [call('toA', 'a', { timeoutMs: 500 })] }), a: service() });
    const result = run(config, [500, 1500, 2500], { faults: [{ service: 'a', startMs: 1000, endMs: 2000, latencyMultiplier: 5 }] });
    expect(latencies(result)).toEqual([24, 64, 24]);
  });
});

describe('simulator: random draws', () => {
  it('gives the same logical work the same draw even when it happens at a different time', () => {
    // Plan: a has jittered work (10 ms ± 90%); s has none. In the second config s takes 20 ms instead of 10,
    //   so each of a's jobs starts 10 ms later. Twenty requests, 1 s apart.
    // Verifies: every request takes exactly 10 ms longer, so a's work got the same random draw in both runs:
    //   draws follow the job's identity, not the time it runs.
    const config = (sMs: number) =>
      withLinks({ s: service({ serviceTimeMs: sMs, calls: [call('toA', 'a')] }), a: service({ serviceTimeJitter: 0.9 }) });
    const arrivals = Array.from({ length: 20 }, (_, i) => i * 1000);
    const earlier = latencies(run(config(10), arrivals, { durationMs: 25_000 }));
    const later = latencies(run(config(20), arrivals, { durationMs: 25_000 }));
    later.forEach((latency, i) => expect(latency - (earlier[i] ?? 0)).toBeCloseTo(10, 9));
    expect(new Set(earlier.map((l) => Math.round(l))).size).toBeGreaterThan(10);
  });

  it('gives a retry its own draw, independent of the attempt it replaces', () => {
    // Plan: a's work is 100 ms ± 90%, and the 102 ms timeout leaves exactly 100 ms for it, so about half of
    //   all attempts time out. Two attempts per call; 400 requests, 1 s apart.
    // Verifies: about 75% of requests succeed (1 − 0.5²). If a retry reused the first attempt's draw, it
    //   would time out whenever the first did, and only about 50% would succeed.
    const config = withLinks({
      s: service({ calls: [call('toA', 'a', { timeoutMs: 102, maxAttempts: 2 })] }),
      a: service({ serviceTimeMs: 100, serviceTimeJitter: 0.9 }),
    });
    const arrivals = Array.from({ length: 400 }, (_, i) => i * 1000);
    const result = run(config, arrivals, { durationMs: 401_000 });
    const successRate = result.requests.filter((r) => r.ok).length / arrivals.length;
    expect(successRate).toBeGreaterThan(0.68);
    expect(successRate).toBeLessThan(0.82);
  });
});

describe('simulator: the demo', () => {
  const demo = demoSystem();
  const traffic = demoScenario();
  const arrivals = poissonArrivals(traffic);

  it('is deterministic', () => {
    // Plan: run the demo twice with the same inputs.
    // Verifies: the results are identical, field for field.
    expect(simulator.run(demo, traffic, arrivals)).toEqual(simulator.run(demo, traffic, arrivals));
  });

  it('gives identical outcomes when configs differ only where it does not matter', () => {
    // Plan: halve api's queue, which never fills in the demo, and run both configs on the same arrivals.
    // Verifies: every request has the same outcome and completion time, so draws depend on identity, not on events.
    const smallerQueue = demoSystem();
    if (smallerQueue.services.api) smallerQueue.services.api.queueCapacity = 500;
    expect(simulator.run(smallerQueue, traffic, arrivals).requests).toEqual(simulator.run(demo, traffic, arrivals).requests);
  });

  it('gives the original and mitigated configs identical outcomes before the fault', () => {
    // Plan: run the original and the fully mitigated demo on the same arrivals. They differ in six kinds of
    //   settings, but before the fault nothing queues long, times out or retries.
    // Verifies: every request that arrives before 9 s has the same outcome and completion time in both runs,
    //   so the comparison after the fault shows the configs' effect, not different random draws.
    const { findings } = analyze(demo);
    const mitigated = applyMitigations(demo, findings, new Set(findings.map((f) => f.id))).config;
    const before = (result: RunResult) => result.requests.filter((r) => r.arrivalMs < 9000);
    expect(before(simulator.run(mitigated, traffic, arrivals))).toEqual(before(simulator.run(demo, traffic, arrivals)));
  });

  it('conserves every request and job', () => {
    // Plan: send only the first 5 s of demo traffic, then let the 60 s run drain.
    // Verifies: per service, arrivals = completions + rejections + expired drops; every user request has a
    //   response, and each response is counted once as goodput, late success or failure.
    const early = arrivals.filter((t) => t < 5000);
    const result = simulator.run(demo, traffic, early);
    for (const name of ['api', 'orders', 'db']) {
      const arrived = sum(result, name, 'firstAttemptArrivals') + sum(result, name, 'retryArrivals');
      const handled = sum(result, name, 'completions') + sum(result, name, 'rejections') + sum(result, name, 'expiredDrops');
      expect(handled).toBe(arrived);
    }
    expect(result.requests.every((r) => r.completionMs !== null)).toBe(true);
    const counted = total(result.buckets, (b) => b.goodput + b.lateSuccesses + b.failures);
    expect(counted).toBe(early.length);
  });

  it('agrees with the analyzer under low load', () => {
    // Plan: run the demo at 5 requests/s with no faults, so nothing queues.
    // Verifies: no request takes longer than the analyzer's healthy(api) + rtt = 48.5 ms, and the mean is within
    //   10% of meanHealthy(api) + rtt = 35 ms, tying the event loop to the budget math.
    const quiet = { ...traffic, rps: 5, faults: [] };
    const result = simulator.run(demo, quiet, poissonArrivals(quiet));
    const budgets = computeBudgets(demo);
    const measured = latencies(result);
    expect(Math.max(...measured)).toBeLessThanOrEqual(budgets.service('api').healthyMs + budgets.rttMs);
    const mean = measured.reduce((a, b) => a + b, 0) / measured.length;
    expect(Math.abs(mean - (budgets.service('api').meanHealthyMs + budgets.rttMs))).toBeLessThan(3.5);
  });

  it('keeps utilization and the wasted fraction within [0, 1]', () => {
    // Plan: run the full demo, fault included, where queues fill and most work is wasted.
    // Verifies: every bucket of every service stays within [0, 1] for both fractions.
    const result = simulator.run(demo, traffic, arrivals);
    for (const bucket of result.buckets) {
      for (const s of Object.values(bucket.services)) {
        expect(s.utilization).toBeGreaterThanOrEqual(0);
        expect(s.utilization).toBeLessThanOrEqual(1 + 1e-9);
        expect(s.wastedFraction).toBeGreaterThanOrEqual(0);
        expect(s.wastedFraction).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
  });

  it('returns a partial result marked truncated when it hits the event cap', () => {
    // Plan: run the demo with a cap of 100 events.
    // Verifies: truncated, exactly 100 events, stopped well before 60 s, and still a full set of buckets.
    const result = createSimulator({ maxEvents: 100 }).run(demo, traffic, arrivals);
    expect(result.truncated).toBe(true);
    expect(result.eventCount).toBe(100);
    expect(result.endedAtMs).toBeLessThan(traffic.durationMs);
    expect(result.buckets).toHaveLength(traffic.durationMs / traffic.bucketMs);
  });
});
