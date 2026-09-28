// Findings and patches (DESIGN.md §7, §8): the analyzer's output and the mitigator's input.

export type RuleId =
  | 'retry-amplification'
  | 'deadline-budget-overrun'
  | 'unguarded-retries'
  | 'missing-deadline-propagation'
  | 'dead-on-arrival-queue';

export type Severity = 'high' | 'medium';

/** A service, or one of its calls when `call` is set. */
export interface Target {
  service: string;
  call?: string;
}

/** One field change. Only fields listed in mitigation/patchableFields.ts may be patched. */
export interface Patch {
  target: Target;
  /** e.g. "maxAttempts", "backoff.jitter", "queueCapacity" */
  field: string;
  from: unknown;
  to: unknown;
}

export interface Mitigation {
  summary: string;
  patches: Patch[];
}

export interface Finding {
  /** Stable across runs: "<rule>:<service>[.<call>]". */
  id: string;
  rule: RuleId;
  severity: Severity;
  target: Target;
  title: string;
  /** Why the combination is risky, with the numbers. */
  explanation: string;
  evidence: Record<string, number | string>;
  /** null when there is no safe automatic mitigation; the finding is then reported as unresolved. */
  mitigation: Mitigation | null;
}
