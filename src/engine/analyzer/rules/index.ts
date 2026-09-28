// All rules, in the order their findings are listed. To add a rule, write one file and add it here.
import { deadlineBudgetOverrun } from './deadlineBudgetOverrun';
import { deadOnArrivalQueue } from './deadOnArrivalQueue';
import { missingDeadlinePropagation } from './missingDeadlinePropagation';
import { retryAmplification } from './retryAmplification';
import type { Rule } from './rule';
import { unguardedRetries } from './unguardedRetries';

export const RULES: readonly Rule[] = [
  retryAmplification,
  deadlineBudgetOverrun,
  unguardedRetries,
  missingDeadlinePropagation,
  deadOnArrivalQueue,
];
