// The analyzer's entry point: a validated system config in, findings and the numbers behind them out.
import { CallGraph } from '../config/callGraph';
import { DEFAULT_ANALYZER_OPTIONS, type AnalyzerOptions, type SystemConfig } from '../config/schema';
import { computeBudgets, type Budgets } from './budget';
import type { Finding } from './finding';
import { RULES } from './rules';

export interface Analysis {
  readonly findings: readonly Finding[];
  readonly budgets: Budgets;
  readonly graph: CallGraph;
}

/** Runs every rule on a validated config. Findings are grouped by rule, in RULES order. */
export function analyze(system: SystemConfig, options: AnalyzerOptions = DEFAULT_ANALYZER_OPTIONS): Analysis {
  const graph = new CallGraph(system.services);
  const budgets = computeBudgets(system, options, graph);
  const context = { system, graph, budgets, options };
  return { findings: RULES.flatMap((rule) => rule.check(context)), budgets, graph };
}
