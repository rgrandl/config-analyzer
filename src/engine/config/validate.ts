// Checks untrusted input against the schema (DESIGN.md §5.4) and returns a typed config or every error found.
// Validation runs in phases: field shapes first, then references between services, then the call graph.
// A later phase only runs when the earlier ones passed, so its checks can rely on well-formed input.
import { CallGraph } from './callGraph';
import { childPath, FieldReader } from './fieldReader';
import { fail, ok, type Result } from './result';
import type {
  BackoffConfig,
  CallConfig,
  Fault,
  RecoveryConfig,
  RetryBudgetConfig,
  Scenario,
  ServiceConfig,
  SystemConfig,
} from './schema';

export const SCENARIO_DEFAULTS = {
  bucketMs: 250,
  recovery: { thresholdPct: 90, windowMs: 1000, holdMs: 3000 },
} as const satisfies Pick<Scenario, 'bucketMs' | 'recovery'>;

/**
 * Service and call names. Dots are excluded because call ids ("caller.call") and error paths use them
 * as separators; with dots, "a.b" + "c" and "a" + "b.c" would both become "a.b.c".
 */
const NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const NAME_RULE = 'must contain only letters, digits, "_" and "-"';

/** Seeds feed a 32-bit hash. */
const MAX_SEED = 2 ** 32 - 1;

/** Own-property lookup, so names such as "constructor" never match inherited object keys. */
function hasService(services: Readonly<Record<string, unknown>>, name: string): boolean {
  return Object.hasOwn(services, name);
}

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

export function validateSystem(raw: unknown): Result<SystemConfig> {
  const reader = new FieldReader();
  const system = readSystem(reader, raw);
  if (!system || reader.errors.length > 0) return fail(reader.errors);

  checkReferences(reader, system);
  if (reader.errors.length > 0) return fail(reader.errors);

  checkGraph(reader, system, new CallGraph(system.services));
  return reader.errors.length > 0 ? fail(reader.errors) : ok(system);
}

function readSystem(r: FieldReader, raw: unknown): SystemConfig | undefined {
  const root = r.object(raw, '');
  if (!root) return undefined;
  r.onlyKeys(root, ['version', 'networkLatencyMs', 'entry', 'services'], '');

  const version = readVersion(r, root, '');
  const networkLatencyMs = r.number(root, 'networkLatencyMs', '', { min: 0 });
  const rttMs = networkLatencyMs === undefined ? undefined : 2 * networkLatencyMs;

  const entryObj = r.object(root.entry, 'entry');
  let entry: SystemConfig['entry'] | undefined;
  if (entryObj) {
    r.onlyKeys(entryObj, ['service', 'deadlineMs'], 'entry');
    const service = r.string(entryObj, 'service', 'entry');
    const deadlineMs = readDuration(r, entryObj, 'deadlineMs', 'entry', rttMs);
    if (service !== undefined && deadlineMs !== undefined) entry = { service, deadlineMs };
  }

  const servicesObj = r.object(root.services, 'services');
  const services: Record<string, ServiceConfig> = {};
  let servicesValid = servicesObj !== undefined;
  if (servicesObj) {
    if (Object.keys(servicesObj).length === 0) r.error('services', 'must define at least one service');
    for (const [name, value] of Object.entries(servicesObj)) {
      if (!NAME_PATTERN.test(name)) r.error(childPath('services', name), `name ${NAME_RULE}`);
      const service = readService(r, value, childPath('services', name), rttMs);
      if (service) services[name] = service;
      else servicesValid = false;
    }
  }

  if (version === undefined || networkLatencyMs === undefined || !entry || !servicesValid) return undefined;
  return { version, networkLatencyMs, entry, services };
}

function readService(r: FieldReader, raw: unknown, path: string, rttMs: number | undefined): ServiceConfig | undefined {
  const obj = r.object(raw, path);
  if (!obj) return undefined;
  r.onlyKeys(
    obj,
    ['workers', 'queueCapacity', 'serviceTimeMs', 'serviceTimeJitter', 'observedP99Ms', 'deadlinePropagation', 'calls'],
    path,
  );

  const workers = r.number(obj, 'workers', path, { integer: true, min: 1 });
  const queueCapacity = readQueueCapacity(r, obj, path);
  const serviceTimeMs = r.number(obj, 'serviceTimeMs', path, { greaterThan: 0 });
  const serviceTimeJitter = r.number(obj, 'serviceTimeJitter', path, { min: 0, max: 0.9 });
  const observedP99Ms = r.optionalNumber(obj, 'observedP99Ms', path, { greaterThan: 0 });
  const deadlinePropagation = r.boolean(obj, 'deadlinePropagation', path);

  const rawCalls = r.array(obj, 'calls', path);
  const calls: CallConfig[] = [];
  let callsValid = rawCalls !== undefined;
  rawCalls?.forEach((rawCall, index) => {
    const call = readCall(r, rawCall, childPath(childPath(path, 'calls'), index), rttMs);
    if (call) calls.push(call);
    else callsValid = false;
  });

  if (
    workers === undefined ||
    queueCapacity === undefined ||
    serviceTimeMs === undefined ||
    serviceTimeJitter === undefined ||
    deadlinePropagation === undefined ||
    !callsValid
  ) {
    return undefined;
  }
  return {
    workers,
    queueCapacity,
    serviceTimeMs,
    serviceTimeJitter,
    ...(observedP99Ms !== undefined && { observedP99Ms }),
    deadlinePropagation,
    calls,
  };
}

function readQueueCapacity(
  r: FieldReader,
  obj: Record<string, unknown>,
  path: string,
): ServiceConfig['queueCapacity'] | undefined {
  if (obj.queueCapacity === 'unbounded') return 'unbounded';
  if (typeof obj.queueCapacity === 'string') {
    r.error(childPath(path, 'queueCapacity'), 'must be a number or "unbounded"');
    return undefined;
  }
  return r.number(obj, 'queueCapacity', path, { integer: true, min: 0 });
}

function readCall(r: FieldReader, raw: unknown, path: string, rttMs: number | undefined): CallConfig | undefined {
  const obj = r.object(raw, path);
  if (!obj) return undefined;
  r.onlyKeys(obj, ['name', 'to', 'timeoutMs', 'maxAttempts', 'backoff', 'retryBudget'], path);

  const name = r.string(obj, 'name', path);
  if (name !== undefined && !NAME_PATTERN.test(name)) r.error(childPath(path, 'name'), NAME_RULE);
  const to = r.string(obj, 'to', path);
  const timeoutMs = readDuration(r, obj, 'timeoutMs', path, rttMs);
  const maxAttempts = r.number(obj, 'maxAttempts', path, { integer: true, min: 1 });
  const backoff = obj.backoff === undefined ? undefined : readBackoff(r, obj.backoff, childPath(path, 'backoff'));
  const retryBudget =
    obj.retryBudget === undefined ? undefined : readRetryBudget(r, obj.retryBudget, childPath(path, 'retryBudget'));

  const optionalValid =
    (obj.backoff === undefined || backoff !== undefined) && (obj.retryBudget === undefined || retryBudget !== undefined);
  if (name === undefined || to === undefined || timeoutMs === undefined || maxAttempts === undefined || !optionalValid) {
    return undefined;
  }
  return { name, to, timeoutMs, maxAttempts, ...(backoff && { backoff }), ...(retryBudget && { retryBudget }) };
}

function readBackoff(r: FieldReader, raw: unknown, path: string): BackoffConfig | undefined {
  const obj = r.object(raw, path);
  if (!obj) return undefined;
  r.onlyKeys(obj, ['baseMs', 'multiplier', 'maxMs', 'jitter'], path);
  const baseMs = r.number(obj, 'baseMs', path, { min: 0 });
  const multiplier = r.number(obj, 'multiplier', path, { min: 1 });
  const maxMs = r.number(obj, 'maxMs', path, { min: 0 });
  const jitter = r.oneOf(obj, 'jitter', path, ['none', 'full'] as const);
  if (baseMs !== undefined && maxMs !== undefined && maxMs < baseMs) {
    r.error(childPath(path, 'maxMs'), `must be ≥ baseMs (${baseMs})`);
    return undefined;
  }
  if (baseMs === undefined || multiplier === undefined || maxMs === undefined || jitter === undefined) return undefined;
  return { baseMs, multiplier, maxMs, jitter };
}

function readRetryBudget(r: FieldReader, raw: unknown, path: string): RetryBudgetConfig | undefined {
  const obj = r.object(raw, path);
  if (!obj) return undefined;
  r.onlyKeys(obj, ['ratio', 'maxTokens'], path);
  const ratio = r.number(obj, 'ratio', path, { greaterThan: 0, max: 1 });
  const maxTokens = r.number(obj, 'maxTokens', path, { min: 1 });
  if (ratio === undefined || maxTokens === undefined) return undefined;
  return { ratio, maxTokens };
}

/** A duration that must exceed the network round trip, since anything shorter can never succeed. */
function readDuration(
  r: FieldReader,
  obj: Record<string, unknown>,
  key: string,
  path: string,
  rttMs: number | undefined,
): number | undefined {
  const value = r.number(obj, key, path, { greaterThan: 0 });
  if (value !== undefined && rttMs !== undefined && value <= rttMs) {
    r.error(childPath(path, key), `must be greater than the network round trip (${rttMs} ms)`);
    return undefined;
  }
  return value;
}

/** Every call targets an existing service other than its caller; call names are unique per service. */
function checkReferences(r: FieldReader, system: SystemConfig): void {
  if (!hasService(system.services, system.entry.service)) {
    r.error('entry.service', `names unknown service "${system.entry.service}"`);
  }
  for (const [name, service] of Object.entries(system.services)) {
    const seen = new Set<string>();
    service.calls.forEach((call, index) => {
      const path = childPath(childPath(childPath('services', name), 'calls'), index);
      if (seen.has(call.name)) r.error(childPath(path, 'name'), `duplicates call name "${call.name}"`);
      seen.add(call.name);
      if (call.to === name) r.error(childPath(path, 'to'), 'a service cannot call itself');
      else if (!hasService(system.services, call.to)) r.error(childPath(path, 'to'), `names unknown service "${call.to}"`);
    });
  }
}

/** The graph is acyclic, the entry has no callers, and every service is reachable from the entry. */
function checkGraph(r: FieldReader, system: SystemConfig, graph: CallGraph): void {
  const cycle = graph.findCycle();
  if (cycle) r.error('services', `calls form a cycle: ${cycle.join(' → ')}`);

  const entry = system.entry.service;
  const callers = graph.callersOf(entry);
  if (callers.length > 0) {
    r.error('entry.service', `the entry service must not be called by other services (called by ${callers[0]?.id})`);
  }
  const reachable = graph.reachableFrom(entry);
  for (const service of graph.services) {
    if (service !== entry && !reachable.has(service)) {
      r.error(childPath('services', service), 'is not reachable from the entry service');
    }
  }
}

// ---------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------

/** Validates a scenario against the system it will run on (faults must name its services). */
export function validateScenario(raw: unknown, system: SystemConfig): Result<Scenario> {
  const reader = new FieldReader();
  const scenario = readScenario(reader, raw, system);
  if (!scenario || reader.errors.length > 0) return fail(reader.errors);

  checkFaultWindows(reader, scenario);
  return reader.errors.length > 0 ? fail(reader.errors) : ok(scenario);
}

function readScenario(r: FieldReader, raw: unknown, system: SystemConfig): Scenario | undefined {
  const root = r.object(raw, '');
  if (!root) return undefined;
  r.onlyKeys(root, ['version', 'rps', 'durationMs', 'warmupMs', 'bucketMs', 'seed', 'faults', 'recovery'], '');

  const version = readVersion(r, root, '');
  const rps = r.number(root, 'rps', '', { greaterThan: 0 });
  const durationMs = r.number(root, 'durationMs', '', { greaterThan: 0 });
  const warmupMs = r.number(root, 'warmupMs', '', { min: 0 });
  const bucketMs =
    root.bucketMs === undefined ? SCENARIO_DEFAULTS.bucketMs : r.number(root, 'bucketMs', '', { greaterThan: 0 });
  const seed = r.number(root, 'seed', '', { integer: true, min: 0, max: MAX_SEED });
  const recovery = root.recovery === undefined ? { ...SCENARIO_DEFAULTS.recovery } : readRecovery(r, root.recovery);

  const rawFaults = root.faults === undefined ? [] : r.array(root, 'faults', '');
  const faults: Fault[] = [];
  let faultsValid = rawFaults !== undefined;
  rawFaults?.forEach((rawFault, index) => {
    const fault = readFault(r, rawFault, childPath('faults', index), system, durationMs);
    if (fault) faults.push(fault);
    else faultsValid = false;
  });

  if (warmupMs !== undefined && durationMs !== undefined && warmupMs >= durationMs) {
    r.error('warmupMs', `must be less than durationMs (${durationMs})`);
  }
  if (
    version === undefined ||
    rps === undefined ||
    durationMs === undefined ||
    warmupMs === undefined ||
    bucketMs === undefined ||
    seed === undefined ||
    !recovery ||
    !faultsValid
  ) {
    return undefined;
  }
  return { version, rps, durationMs, warmupMs, bucketMs, seed, faults, recovery };
}

function readFault(
  r: FieldReader,
  raw: unknown,
  path: string,
  system: SystemConfig,
  durationMs: number | undefined,
): Fault | undefined {
  const obj = r.object(raw, path);
  if (!obj) return undefined;
  r.onlyKeys(obj, ['service', 'startMs', 'endMs', 'latencyMultiplier', 'errorRate'], path);

  const service = r.string(obj, 'service', path);
  if (service !== undefined && !hasService(system.services, service)) {
    r.error(childPath(path, 'service'), `names unknown service "${service}"`);
  }
  const startMs = r.number(obj, 'startMs', path, { min: 0 });
  const endMs = r.number(obj, 'endMs', path, { greaterThan: 0 });
  const latencyMultiplier = r.optionalNumber(obj, 'latencyMultiplier', path, { greaterThan: 0 });
  const errorRate = r.optionalNumber(obj, 'errorRate', path, { min: 0, max: 1 });

  if (startMs !== undefined && endMs !== undefined && startMs >= endMs) {
    r.error(childPath(path, 'endMs'), `must be greater than startMs (${startMs})`);
  }
  if (endMs !== undefined && durationMs !== undefined && endMs > durationMs) {
    r.error(childPath(path, 'endMs'), `must be ≤ durationMs (${durationMs})`);
  }
  if (service === undefined || startMs === undefined || endMs === undefined) return undefined;
  return {
    service,
    startMs,
    endMs,
    ...(latencyMultiplier !== undefined && { latencyMultiplier }),
    ...(errorRate !== undefined && { errorRate }),
  };
}

function readRecovery(r: FieldReader, raw: unknown): RecoveryConfig | undefined {
  const obj = r.object(raw, 'recovery');
  if (!obj) return undefined;
  r.onlyKeys(obj, ['thresholdPct', 'windowMs', 'holdMs'], 'recovery');
  const thresholdPct = r.number(obj, 'thresholdPct', 'recovery', { greaterThan: 0, max: 100 });
  const windowMs = r.number(obj, 'windowMs', 'recovery', { greaterThan: 0 });
  const holdMs = r.number(obj, 'holdMs', 'recovery', { greaterThan: 0 });
  // Recovery checks the windows that start within [t, t + holdMs − windowMs]; a shorter hold leaves none.
  if (holdMs !== undefined && windowMs !== undefined && holdMs < windowMs) {
    r.error('recovery.holdMs', `must be ≥ recovery.windowMs (${windowMs})`);
    return undefined;
  }
  if (thresholdPct === undefined || windowMs === undefined || holdMs === undefined) return undefined;
  return { thresholdPct, windowMs, holdMs };
}

/** Faults leave room for a baseline before the first one, and faults on one service do not overlap. */
function checkFaultWindows(r: FieldReader, scenario: Scenario): void {
  const earliestStart = scenario.warmupMs + scenario.recovery.windowMs;
  scenario.faults.forEach((fault, index) => {
    if (fault.startMs < earliestStart) {
      r.error(
        childPath(childPath('faults', index), 'startMs'),
        `must be ≥ warmupMs + recovery.windowMs (${earliestStart}) so a baseline can be measured`,
      );
    }
    scenario.faults.slice(0, index).forEach((other, otherIndex) => {
      if (other.service === fault.service && fault.startMs < other.endMs && other.startMs < fault.endMs) {
        r.error(childPath('faults', index), `overlaps faults[${otherIndex}] on service "${fault.service}"`);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

function readVersion(r: FieldReader, obj: Record<string, unknown>, path: string): 1 | undefined {
  const version = r.number(obj, 'version', path);
  if (version === undefined) return undefined;
  if (version !== 1) {
    r.error(childPath(path, 'version'), `unsupported version ${version}; expected 1`);
    return undefined;
  }
  return 1;
}
