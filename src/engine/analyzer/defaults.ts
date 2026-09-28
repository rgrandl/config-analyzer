// Values the analyzer recommends. The budget math uses them ahead of time (DESIGN.md §6), so that a call's
// worst case already includes what the unguarded-retries rule will add.
import type { BackoffConfig, RetryBudgetConfig } from '../config/schema';

export const DEFAULT_BACKOFF: Readonly<BackoffConfig> = { baseMs: 10, multiplier: 2, maxMs: 100, jitter: 'full' };

export const DEFAULT_RETRY_BUDGET: Readonly<RetryBudgetConfig> = { ratio: 0.1, maxTokens: 10 };

/** A recommended queue drains within half of the time left after the work itself (rule 5). */
export const QUEUE_HEADROOM = 0.5;
