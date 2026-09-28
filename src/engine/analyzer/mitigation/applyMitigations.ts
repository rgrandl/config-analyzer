// Applies the selected findings' patches and re-checks the result (DESIGN.md §8):
// merge patches per field (the more conservative value wins), apply them to a copy of the config,
// then run the analyzer once more and report what is still unresolved and what is new.
import type { AnalyzerOptions, SystemConfig } from '../../config/schema';
import { DEFAULT_ANALYZER_OPTIONS } from '../../config/schema';
import { validateSystem } from '../../config/validate';
import { analyze, type Analysis } from '../analyze';
import { targetKey, type Finding, type Patch } from '../finding';
import { mergeValues, movesConservatively, patchableField } from './patchableFields';

/** A merged patch, with the findings that asked for it. */
export interface AppliedPatch extends Patch {
  readonly findingIds: readonly string[];
}

export interface MitigationResult {
  /** The mitigated config; the input config is never modified. */
  readonly config: SystemConfig;
  readonly applied: readonly AppliedPatch[];
  /** Findings of the re-run that were already present before: not fixed, or fixed only partly. */
  readonly unresolved: readonly Finding[];
  /** Findings of the re-run that were not present before. */
  readonly introduced: readonly Finding[];
  /** The analysis of the mitigated config. */
  readonly analysis: Analysis;
}

export function applyMitigations(
  system: SystemConfig,
  findings: readonly Finding[],
  selectedIds: ReadonlySet<string>,
  options: AnalyzerOptions = DEFAULT_ANALYZER_OPTIONS,
): MitigationResult {
  const selected = findings.filter((finding) => selectedIds.has(finding.id));
  const applied = mergePatches(selected);

  const config = structuredClone(system);
  for (const patch of applied) applyPatch(config, patch);

  // Mitigations only tighten valid settings, so the result must still be valid; if not, a rule is wrong.
  const validation = validateSystem(config);
  if (!validation.ok) {
    throw new Error(`Mitigations produced an invalid config: ${JSON.stringify(validation.errors)}`);
  }

  const analysis = analyze(config, options);
  return { config, applied, ...classifyFindings(findings, analysis.findings), analysis };
}

/** One patch per (target, field), merged by the field table; refuses fields outside it and unsafe directions. */
export function mergePatches(findings: readonly Finding[]): AppliedPatch[] {
  const merged = new Map<string, AppliedPatch>();
  for (const finding of findings) {
    for (const patch of finding.mitigation?.patches ?? []) {
      const row = patchableField(patch.target, patch.field);
      if (!row) throw new Error(`Field "${patch.field}" of ${targetKey(patch.target)} is not patchable`);
      if (!movesConservatively(row.kind, patch.from, patch.to)) {
        throw new Error(
          `Patch of ${targetKey(patch.target)}.${patch.field} from ${JSON.stringify(patch.from)} to ` +
            `${JSON.stringify(patch.to)} is not a ${row.kind} change`,
        );
      }

      const key = `${targetKey(patch.target)}#${patch.field}`;
      const existing = merged.get(key);
      merged.set(
        key,
        existing
          ? { ...existing, to: mergeValues(row.kind, existing.to, patch.to), findingIds: [...existing.findingIds, finding.id] }
          : { ...patch, findingIds: [finding.id] },
      );
    }
  }
  return [...merged.values()];
}

/** Splits re-run findings into those already present before mitigation and those introduced by it. */
export function classifyFindings(
  before: readonly Finding[],
  after: readonly Finding[],
): { unresolved: Finding[]; introduced: Finding[] } {
  const beforeIds = new Set(before.map((finding) => finding.id));
  return {
    unresolved: after.filter((finding) => beforeIds.has(finding.id)),
    introduced: after.filter((finding) => !beforeIds.has(finding.id)),
  };
}

/** Sets one field on the mitigated copy, after checking it still holds the value the patch expects. */
function applyPatch(config: SystemConfig, patch: Patch): void {
  const service = config.services[patch.target.service];
  if (!service) throw new Error(`Unknown service "${patch.target.service}"`);
  const owner =
    patch.target.call === undefined ? service : service.calls.find((call) => call.name === patch.target.call);
  if (!owner) throw new Error(`Unknown call ${targetKey(patch.target)}`);

  const path = patch.field.split('.');
  const last = path.pop();
  let parent: Record<string, unknown> = owner as unknown as Record<string, unknown>;
  for (const key of path) {
    const next = parent[key];
    if (typeof next !== 'object' || next === null) throw new Error(`Cannot patch ${targetKey(patch.target)}.${patch.field}`);
    parent = next as Record<string, unknown>;
  }
  if (last === undefined) throw new Error('Empty patch field');
  if (JSON.stringify(parent[last]) !== JSON.stringify(patch.from)) {
    throw new Error(`Patch of ${targetKey(patch.target)}.${patch.field} expected ${JSON.stringify(patch.from)}`);
  }
  parent[last] = structuredClone(patch.to);
}
