// The four runs behind the demo's comparison (DESIGN.md §9.5): the original and the mitigated config,
// each with the scenario's faults and without them. Arrivals are generated once and shared by all four,
// so any difference between runs comes from the configs and the faults, not from different traffic.
import type { Ms, Scenario, SystemConfig } from '../config/schema';
import { poissonArrivals } from './arrivals';
import { simulator } from './run';
import { summarizeRun, type RunSummary } from './summary';
import type { ArrivalSource, Runner, RunResult } from './types';

export interface SummarizedRun {
  readonly result: RunResult;
  readonly summary: RunSummary;
}

export interface ConfigRuns {
  readonly withFaults: SummarizedRun;
  /** The same traffic without faults; timeouts here are false timeouts. */
  readonly withoutFaults: SummarizedRun;
}

export interface Comparison {
  readonly original: ConfigRuns;
  readonly mitigated: ConfigRuns;
  readonly arrivals: readonly Ms[];
}

export function compareRuns(
  original: SystemConfig,
  mitigated: SystemConfig,
  scenario: Scenario,
  runner: Runner = simulator,
  arrivalSource: ArrivalSource = poissonArrivals,
): Comparison {
  const arrivals = arrivalSource(scenario);
  const quiet: Scenario = { ...scenario, faults: [] };
  const runBoth = (system: SystemConfig): ConfigRuns => ({
    withFaults: summarized(runner, system, scenario, arrivals),
    withoutFaults: summarized(runner, system, quiet, arrivals),
  });
  return { original: runBoth(original), mitigated: runBoth(mitigated), arrivals };
}

function summarized(runner: Runner, system: SystemConfig, scenario: Scenario, arrivals: readonly Ms[]): SummarizedRun {
  const result = runner.run(system, scenario, [...arrivals]);
  return { result, summary: summarizeRun(result, system, scenario) };
}
