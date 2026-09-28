// Entry points for the UI: YAML text → validated config, or every error found.
import { parseYaml } from './parse';
import type { Result } from './result';
import type { Scenario, SystemConfig } from './schema';
import { validateScenario, validateSystem } from './validate';

export function loadSystem(text: string): Result<SystemConfig> {
  const parsed = parseYaml(text);
  return parsed.ok ? validateSystem(parsed.value) : parsed;
}

export function loadScenario(text: string, system: SystemConfig): Result<Scenario> {
  const parsed = parseYaml(text);
  return parsed.ok ? validateScenario(parsed.value, system) : parsed;
}
