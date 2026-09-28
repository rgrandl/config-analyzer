// Shared test fixtures: the demo configs, and small builders for hand-made systems.
import { parse } from 'yaml';
import { loadScenario, loadSystem } from '../../src/engine/config/load';
import type { CallConfig, Scenario, ServiceConfig, SystemConfig } from '../../src/engine/config/schema';
import { DEMO_SCENARIO_YAML, DEMO_SYSTEM_YAML } from '../../src/demo';

/** The demo system, validated. */
export function demoSystem(): SystemConfig {
  const result = loadSystem(DEMO_SYSTEM_YAML);
  if (!result.ok) throw new Error(`Demo system is invalid: ${JSON.stringify(result.errors)}`);
  return result.value;
}

/** The demo scenario, validated. */
export function demoScenario(): Scenario {
  const result = loadScenario(DEMO_SCENARIO_YAML, demoSystem());
  if (!result.ok) throw new Error(`Demo scenario is invalid: ${JSON.stringify(result.errors)}`);
  return result.value;
}

/** The demo documents as raw parsed YAML, for tests that break them on purpose. */
export function rawDemoSystem(): any {
  return parse(DEMO_SYSTEM_YAML);
}

export function rawDemoScenario(): any {
  return parse(DEMO_SCENARIO_YAML);
}

/** A service with plain defaults: fast, one worker per request, no calls. */
export function service(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    workers: 10,
    queueCapacity: 10,
    serviceTimeMs: 10,
    serviceTimeJitter: 0,
    deadlinePropagation: false,
    calls: [],
    ...overrides,
  };
}

/** A single-attempt call; override anything else. */
export function call(name: string, to: string, overrides: Partial<CallConfig> = {}): CallConfig {
  return { name, to, timeoutMs: 100, maxAttempts: 1, ...overrides };
}

/** A system with zero network latency, entered at `entry`. */
export function system(
  services: Record<string, ServiceConfig>,
  overrides: Partial<Omit<SystemConfig, 'services'>> = {},
): SystemConfig {
  const [first] = Object.keys(services);
  return {
    version: 1,
    networkLatencyMs: 0,
    entry: { service: first ?? 'entry', deadlineMs: 1000 },
    services,
    ...overrides,
  };
}

/** A 10 s scenario with no faults; tests usually pass their own arrival times to the runner. */
export function scenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    version: 1,
    rps: 10,
    durationMs: 10_000,
    warmupMs: 0,
    bucketMs: 250,
    seed: 1,
    faults: [],
    recovery: { thresholdPct: 90, windowMs: 1000, holdMs: 3000 },
    ...overrides,
  };
}

/** Sums one numeric field over all buckets, for one service or one call. */
export function total<T>(items: readonly T[], pick: (item: T) => number): number {
  return items.reduce((sum, item) => sum + pick(item), 0);
}
