// Values the analyzer recommends. Budget math uses DEFAULT_BACKOFF ahead of time, so that a call's
// worst case already includes the backoff the unguarded-retries rule will add (DESIGN.md §6).
import type { BackoffConfig } from '../config/schema';

export const DEFAULT_BACKOFF: Readonly<BackoffConfig> = { baseMs: 10, multiplier: 2, maxMs: 100, jitter: 'full' };
