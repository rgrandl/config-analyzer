import { describe, expect, it } from 'vitest';
import type { ConfigError } from '../../../src/engine/config/result';
import { validateScenario, validateSystem } from '../../../src/engine/config/validate';
import { demoSystem, rawDemoScenario, rawDemoSystem } from '../../helpers/fixtures';

/** Errors of a failed validation; fails the test if validation passed. */
function errorsOf(result: ReturnType<typeof validateSystem> | ReturnType<typeof validateScenario>): ConfigError[] {
  expect(result.ok).toBe(false);
  return result.ok ? [] : [...result.errors];
}

describe('validateSystem', () => {
  it('accepts the demo system unchanged', () => {
    // Plan: validate the demo system as written in src/demo/system.yaml.
    // Verifies: validation passes and keeps the values, e.g. placeOrder's 900 ms timeout.
    const result = validateSystem(rawDemoSystem());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.services.api?.calls[0]?.timeoutMs).toBe(900);
  });

  it('accepts an unbounded queue', () => {
    // Plan: set the db queue to "unbounded".
    // Verifies: it is valid and kept as the string "unbounded".
    const raw = rawDemoSystem();
    raw.services.db.queueCapacity = 'unbounded';
    const result = validateSystem(raw);
    expect(result.ok && result.value.services.db?.queueCapacity).toBe('unbounded');
  });

  // Plan: break the demo system in exactly one way per case.
  // Verifies: validation fails with an error at the expected path, whose message explains the rule.
  it.each<[string, (raw: any) => void, string, RegExp]>([
    ['unsupported version', (s) => (s.version = 2), 'version', /unsupported version/],
    ['missing field', (s) => delete s.services.api.workers, 'services.api.workers', /required/],
    ['unknown field (typo)', (s) => (s.services.api.calls[0].maxAttempt = 2), 'services.api.calls[0].maxAttempt', /not a known field/],
    ['non-integer workers', (s) => (s.services.db.workers = 1.5), 'services.db.workers', /integer/],
    ['zero workers', (s) => (s.services.db.workers = 0), 'services.db.workers', /≥ 1/],
    ['negative queue', (s) => (s.services.db.queueCapacity = -1), 'services.db.queueCapacity', /≥ 0/],
    ['queue as other string', (s) => (s.services.db.queueCapacity = 'big'), 'services.db.queueCapacity', /unbounded/],
    ['zero service time', (s) => (s.services.db.serviceTimeMs = 0), 'services.db.serviceTimeMs', /> 0/],
    ['jitter above 0.9', (s) => (s.services.db.serviceTimeJitter = 1), 'services.db.serviceTimeJitter', /≤ 0.9/],
    ['non-positive observed p99', (s) => (s.services.db.observedP99Ms = 0), 'services.db.observedP99Ms', /> 0/],
    ['non-boolean propagation', (s) => (s.services.db.deadlinePropagation = 'yes'), 'services.db.deadlinePropagation', /true or false/],
    ['zero attempts', (s) => (s.services.api.calls[0].maxAttempts = 0), 'services.api.calls[0].maxAttempts', /≥ 1/],
    ['more than 100 attempts', (s) => (s.services.api.calls[0].maxAttempts = 101), 'services.api.calls[0].maxAttempts', /≤ 100/],
    ['timeout within the round trip', (s) => (s.services.api.calls[0].timeoutMs = 2), 'services.api.calls[0].timeoutMs', /round trip/],
    ['deadline within the round trip', (s) => (s.entry.deadlineMs = 2), 'entry.deadlineMs', /round trip/],
    ['backoff multiplier below 1', (s) => (s.services.api.calls[0].backoff = { baseMs: 10, multiplier: 0.5, maxMs: 100, jitter: 'full' }), 'services.api.calls[0].backoff.multiplier', /≥ 1/],
    ['backoff max below base', (s) => (s.services.api.calls[0].backoff = { baseMs: 50, multiplier: 2, maxMs: 10, jitter: 'full' }), 'services.api.calls[0].backoff.maxMs', /≥ baseMs/],
    ['unknown jitter', (s) => (s.services.api.calls[0].backoff = { baseMs: 10, multiplier: 2, maxMs: 100, jitter: 'some' }), 'services.api.calls[0].backoff.jitter', /one of/],
    ['retry budget ratio above 1', (s) => (s.services.api.calls[0].retryBudget = { ratio: 2, maxTokens: 10 }), 'services.api.calls[0].retryBudget.ratio', /≤ 1/],
    ['unknown entry service', (s) => (s.entry.service = 'gateway'), 'entry.service', /unknown service "gateway"/],
    ['call to unknown service', (s) => (s.services.orders.calls[0].to = 'cache'), 'services.orders.calls[0].to', /unknown service "cache"/],
    ['self call', (s) => (s.services.db.calls = [{ name: 'again', to: 'db', timeoutMs: 50, maxAttempts: 1 }]), 'services.db.calls[0].to', /cannot call itself/],
    ['duplicate call name', (s) => (s.services.orders.calls[1].name = 'readStock'), 'services.orders.calls[1].name', /duplicates/],
    ['cycle', (s) => (s.services.db.calls = [{ name: 'back', to: 'orders', timeoutMs: 50, maxAttempts: 1 }]), 'services', /cycle: orders → db → orders/],
    ['entry has callers', (s) => (s.services.orders.calls.push({ name: 'up', to: 'api', timeoutMs: 50, maxAttempts: 1 })), 'entry.service', /must not be called/],
    ['unreachable service', (s) => (s.services.cache = { workers: 1, queueCapacity: 1, serviceTimeMs: 1, serviceTimeJitter: 0, deadlinePropagation: false, calls: [] }), 'services.cache', /not reachable/],
    ['dot in a service name', (s) => (s.services['db.v2'] = s.services.db), 'services.db.v2', /letters, digits/],
    ['dot in a call name', (s) => (s.services.orders.calls[0].name = 'read.stock'), 'services.orders.calls[0].name', /letters, digits/],
    ['call to an inherited object key', (s) => (s.services.orders.calls[0].to = 'constructor'), 'services.orders.calls[0].to', /unknown service "constructor"/],
  ])('rejects %s', (_name, breakIt, path, message) => {
    const raw = rawDemoSystem();
    breakIt(raw);
    const errors = errorsOf(validateSystem(raw));
    expect(errors).toContainEqual({ path, message: expect.stringMatching(message) });
  });

  it('reports all field errors in one pass', () => {
    // Plan: break three unrelated fields in different services.
    // Verifies: all three errors are returned together, each with its own path.
    const raw = rawDemoSystem();
    raw.services.api.workers = 0;
    raw.services.orders.serviceTimeMs = -1;
    raw.services.db.deadlinePropagation = 'no';
    const paths = errorsOf(validateSystem(raw)).map((error) => error.path);
    expect(paths).toEqual(['services.api.workers', 'services.orders.serviceTimeMs', 'services.db.deadlinePropagation']);
  });

  it('skips graph checks while fields are invalid', () => {
    // Plan: make a field invalid and also add a call to an unknown service.
    // Verifies: only the field error is reported; reference checks wait until fields are valid.
    const raw = rawDemoSystem();
    raw.services.db.workers = 0;
    raw.services.orders.calls[0].to = 'cache';
    const paths = errorsOf(validateSystem(raw)).map((error) => error.path);
    expect(paths).toEqual(['services.db.workers']);
  });

  it('rejects a document that is not a map', () => {
    // Plan: validate a list instead of a map.
    // Verifies: a single error for the whole document.
    expect(errorsOf(validateSystem([1, 2]))).toEqual([{ path: '', message: 'must be an object' }]);
  });
});

describe('validateScenario', () => {
  it('accepts the demo scenario unchanged', () => {
    // Plan: validate the demo scenario against the demo system.
    // Verifies: validation passes and keeps the db fault window.
    const result = validateScenario(rawDemoScenario(), demoSystem());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.faults[0]).toMatchObject({ service: 'db', startMs: 10000, endMs: 20000 });
  });

  it('fills in defaults for omitted optional fields', () => {
    // Plan: remove bucketMs, recovery and faults from the demo scenario.
    // Verifies: they default to 250 ms buckets, recovery 90% / 1 s / 3 s, and no faults.
    const raw = rawDemoScenario();
    delete raw.bucketMs;
    delete raw.recovery;
    delete raw.faults;
    const result = validateScenario(raw, demoSystem());
    expect(result.ok && result.value).toMatchObject({
      bucketMs: 250,
      recovery: { thresholdPct: 90, windowMs: 1000, holdMs: 3000 },
      faults: [],
    });
  });

  // Plan: break the demo scenario in exactly one way per case.
  // Verifies: validation fails with an error at the expected path, whose message explains the rule.
  it.each<[string, (raw: any) => void, string, RegExp]>([
    ['zero rps', (s) => (s.rps = 0), 'rps', /> 0/],
    ['non-integer seed', (s) => (s.seed = 1.5), 'seed', /integer/],
    ['warm-up as long as the run', (s) => (s.warmupMs = 60000), 'warmupMs', /less than durationMs/],
    ['fault on unknown service', (s) => (s.faults[0].service = 'cache'), 'faults[0].service', /unknown service/],
    ['fault ending before it starts', (s) => (s.faults[0].endMs = 9000), 'faults[0].endMs', /greater than startMs/],
    ['fault beyond the run', (s) => (s.faults[0].endMs = 70000), 'faults[0].endMs', /≤ durationMs/],
    ['error rate above 1', (s) => (s.faults[0].errorRate = 1.5), 'faults[0].errorRate', /≤ 1/],
    ['fault before a baseline exists', (s) => (s.faults[0].startMs = 2500), 'faults[0].startMs', /baseline/],
    ['fault too late to confirm recovery', (s) => (s.faults[0].endMs = 56001), 'faults[0].endMs', /≤ .*\(56000\).*confirmed/],
    ['fault that sets neither effect', (s) => delete s.faults[0].latencyMultiplier, 'faults[0]', /latencyMultiplier or errorRate/],
    ['fault whose effects do nothing', (s) => (s.faults[0].latencyMultiplier = 1), 'faults[0]', /no effect/],
    ['overlapping faults on one service', (s) => s.faults.push({ service: 'db', startMs: 15000, endMs: 25000, errorRate: 0.1 }), 'faults[1]', /overlaps faults\[0\]/],
    ['threshold above 100', (s) => (s.recovery.thresholdPct = 120), 'recovery.thresholdPct', /≤ 100/],
    ['hold shorter than the window', (s) => (s.recovery.holdMs = 500), 'recovery.holdMs', /≥ recovery.windowMs/],
    ['window shorter than the 100 ms grid', (s) => (s.recovery.windowMs = 50), 'recovery.windowMs', /≥ 100/],
    ['seed beyond 32 bits', (s) => (s.seed = 2 ** 32), 'seed', /≤ 4294967295/],
  ])('rejects %s', (_name, breakIt, path, message) => {
    const raw = rawDemoScenario();
    breakIt(raw);
    const errors = errorsOf(validateScenario(raw, demoSystem()));
    expect(errors).toContainEqual({ path, message: expect.stringMatching(message) });
  });

  it('allows a fault that ends exactly when recovery can still be confirmed', () => {
    // Plan: end the demo fault at durationMs − holdMs − deadlineMs = 60000 − 3000 − 1000 = 56000.
    // Verifies: the boundary itself is valid, so the check is ≤, not <.
    const raw = rawDemoScenario();
    raw.faults[0].endMs = 56000;
    expect(validateScenario(raw, demoSystem()).ok).toBe(true);
  });

  it('allows back-to-back faults on one service', () => {
    // Plan: add a second db fault that starts exactly when the first one ends.
    // Verifies: touching windows are not treated as overlapping.
    const raw = rawDemoScenario();
    raw.faults.push({ service: 'db', startMs: 20000, endMs: 25000, latencyMultiplier: 2 });
    expect(validateScenario(raw, demoSystem()).ok).toBe(true);
  });
});
