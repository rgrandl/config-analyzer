// Guards the demo files that the analyzer and simulator expectations (DESIGN.md §11) depend on.
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { DEMO_SCENARIO_YAML, DEMO_SYSTEM_YAML } from '../../src/demo';

describe('demo configs', () => {
  const system = parse(DEMO_SYSTEM_YAML);
  const scenario = parse(DEMO_SCENARIO_YAML);

  it('are version 1', () => {
    expect(system.version).toBe(1);
    expect(scenario.version).toBe(1);
  });

  it('describe api → orders → db', () => {
    expect(Object.keys(system.services)).toEqual(['api', 'orders', 'db']);
    expect(system.entry).toEqual({ service: 'api', deadlineMs: 1000 });
  });

  it('keep the calibrated values', () => {
    expect(system.services.api.calls[0]).toMatchObject({ name: 'placeOrder', timeoutMs: 900, maxAttempts: 3 });
    expect(system.services.orders.calls.map((c: { name: string }) => c.name)).toEqual(['readStock', 'writeOrder']);
    expect(scenario.faults).toEqual([{ service: 'db', startMs: 10000, endMs: 20000, latencyMultiplier: 5 }]);
  });
});
