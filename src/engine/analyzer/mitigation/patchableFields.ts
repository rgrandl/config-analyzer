// The only fields a mitigation may change (DESIGN.md §8), and how. A plain table: each row says which way
// a value may move, which is also how two patches to the same field are merged. Moving the other way is a
// bug, and applyMitigations refuses it.
import type { Target } from '../finding';

/**
 * - lower: may only decrease; merged by minimum. "unbounded" counts as larger than any number.
 * - raise: may only increase; merged by maximum.
 * - enable: may only become true.
 * - add-if-absent: may only be set where nothing is configured; the first patch wins.
 * - full-jitter: may only become "full".
 */
export type FieldKind = 'lower' | 'raise' | 'enable' | 'add-if-absent' | 'full-jitter';

export interface PatchableField {
  readonly level: 'service' | 'call';
  /** Dotted path within the service or call, e.g. "backoff.baseMs". */
  readonly field: string;
  readonly kind: FieldKind;
}

export const PATCHABLE_FIELDS: readonly PatchableField[] = [
  { level: 'call', field: 'timeoutMs', kind: 'lower' },
  { level: 'call', field: 'maxAttempts', kind: 'lower' },
  { level: 'call', field: 'backoff', kind: 'add-if-absent' },
  { level: 'call', field: 'backoff.baseMs', kind: 'raise' },
  { level: 'call', field: 'backoff.maxMs', kind: 'raise' },
  { level: 'call', field: 'backoff.jitter', kind: 'full-jitter' },
  { level: 'call', field: 'retryBudget', kind: 'add-if-absent' },
  { level: 'service', field: 'queueCapacity', kind: 'lower' },
  { level: 'service', field: 'deadlinePropagation', kind: 'enable' },
];

export function patchableField(target: Target, field: string): PatchableField | undefined {
  const level = target.call === undefined ? 'service' : 'call';
  return PATCHABLE_FIELDS.find((row) => row.level === level && row.field === field);
}

/** Whether changing a field from `from` to `to` moves it only in its allowed direction. */
export function movesConservatively(kind: FieldKind, from: unknown, to: unknown): boolean {
  switch (kind) {
    case 'lower':
      return typeof to === 'number' && to <= magnitude(from);
    case 'raise':
      return typeof to === 'number' && typeof from === 'number' && to >= from;
    case 'enable':
      return to === true;
    case 'add-if-absent':
      return from === undefined && to !== undefined;
    case 'full-jitter':
      return to === 'full';
  }
}

/** Combines two patches' target values for the same field: the more conservative one wins. */
export function mergeValues(kind: FieldKind, a: unknown, b: unknown): unknown {
  switch (kind) {
    case 'lower':
      return magnitude(a) <= magnitude(b) ? a : b;
    case 'raise':
      return magnitude(a) >= magnitude(b) ? a : b;
    case 'enable':
      return true;
    case 'add-if-absent':
      return a;
    case 'full-jitter':
      return 'full';
  }
}

function magnitude(value: unknown): number {
  if (value === 'unbounded') return Infinity;
  if (typeof value !== 'number') throw new Error(`Expected a number or "unbounded", got ${JSON.stringify(value)}`);
  return value;
}
