// Small formatting helpers for finding titles and explanations.
import type { Ms } from '../config/schema';

/** Milliseconds with at most one decimal, e.g. "410.5 ms", "995 ms", "∞ ms". */
export function formatMs(value: Ms): string {
  if (!Number.isFinite(value)) return '∞ ms';
  return `${Math.round(value * 10) / 10} ms`;
}

/** "1 attempt", "3 attempts". */
export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** "a", "a and b", "a, b and c". */
export function listPhrase(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}
