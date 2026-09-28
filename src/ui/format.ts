// Plain-language formatting of engine values for the interface.
import type { Patch } from '../engine/analyzer/finding';
import type { BackoffConfig, RetryBudgetConfig } from '../engine/config/schema';

/** "api → orders (placeOrder)" for a call, or "db" for a service. */
export function targetLabel(target: Patch['target'], calleeOf?: (service: string, call: string) => string | undefined) {
  if (target.call === undefined) return target.service;
  const callee = calleeOf?.(target.service, target.call);
  return callee ? `${target.service} → ${callee} (${target.call})` : `${target.service}.${target.call}`;
}

/** A patch as one readable line: "maxAttempts: 3 → 1", "backoff: none → 10 ms × 2, up to 100 ms, full jitter". */
export function patchLine(patch: Pick<Patch, 'field' | 'from' | 'to'>): string {
  return `${patch.field}: ${formatValue(patch.field, patch.from)} → ${formatValue(patch.field, patch.to)}`;
}

function formatValue(field: string, value: unknown): string {
  if (value === undefined) return 'none';
  if (field === 'backoff') return formatBackoff(value as BackoffConfig);
  if (field === 'retryBudget') return formatRetryBudget(value as RetryBudgetConfig);
  if (typeof value === 'number') return field.endsWith('Ms') ? `${formatNumber(value)} ms` : formatNumber(value);
  return String(value);
}

function formatBackoff(backoff: BackoffConfig): string {
  const jitter = backoff.jitter === 'full' ? 'full jitter' : 'no jitter';
  return `${backoff.baseMs} ms × ${backoff.multiplier}, up to ${backoff.maxMs} ms, ${jitter}`;
}

function formatRetryBudget(budget: RetryBudgetConfig): string {
  return `retries up to ${Math.round(budget.ratio * 100)}% of requests, ${budget.maxTokens} in reserve`;
}

/** At most one decimal: 410.5, 995, 0.2. */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '∞';
  return String(Math.round(value * 10) / 10);
}
