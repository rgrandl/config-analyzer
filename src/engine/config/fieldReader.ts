// Typed field access over untrusted input that records an error, with its path, instead of throwing.
// Every read returns undefined when the field is missing or invalid, so callers can keep going and
// report all errors in one pass.
import type { ConfigError } from './result';

export interface NumberRule {
  integer?: boolean;
  /** Inclusive lower bound. */
  min?: number;
  /** Exclusive lower bound. */
  greaterThan?: number;
  /** Inclusive upper bound. */
  max?: number;
}

type Obj = Record<string, unknown>;

export function childPath(path: string, key: string | number): string {
  if (typeof key === 'number') return `${path}[${key}]`;
  return path === '' ? key : `${path}.${key}`;
}

export class FieldReader {
  readonly errors: ConfigError[] = [];

  error(path: string, message: string): void {
    this.errors.push({ path, message });
  }

  /** The value as a plain object (not an array), or undefined with an error. */
  object(value: unknown, path: string): Obj | undefined {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Obj;
    this.error(path, value === undefined ? 'is required' : 'must be an object');
    return undefined;
  }

  /** Records an error for every key not in `allowed`, so typos such as "maxAttempt" are not ignored. */
  onlyKeys(obj: Obj, allowed: readonly string[], path: string): void {
    for (const key of Object.keys(obj)) {
      if (!allowed.includes(key)) this.error(childPath(path, key), 'is not a known field');
    }
  }

  number(obj: Obj, key: string, path: string, rule: NumberRule = {}): number | undefined {
    const fieldPath = childPath(path, key);
    const value = obj[key];
    if (value === undefined) return this.missing(fieldPath);
    if (typeof value !== 'number' || !Number.isFinite(value)) return this.invalid(fieldPath, 'must be a number');
    if (rule.integer && !Number.isInteger(value)) return this.invalid(fieldPath, 'must be an integer');
    if (rule.min !== undefined && value < rule.min) return this.invalid(fieldPath, `must be ≥ ${rule.min}`);
    if (rule.greaterThan !== undefined && value <= rule.greaterThan) {
      return this.invalid(fieldPath, `must be > ${rule.greaterThan}`);
    }
    if (rule.max !== undefined && value > rule.max) return this.invalid(fieldPath, `must be ≤ ${rule.max}`);
    return value;
  }

  optionalNumber(obj: Obj, key: string, path: string, rule: NumberRule = {}): number | undefined {
    return obj[key] === undefined ? undefined : this.number(obj, key, path, rule);
  }

  string(obj: Obj, key: string, path: string): string | undefined {
    const fieldPath = childPath(path, key);
    const value = obj[key];
    if (value === undefined) return this.missing(fieldPath);
    if (typeof value !== 'string' || value === '') return this.invalid(fieldPath, 'must be a non-empty string');
    return value;
  }

  boolean(obj: Obj, key: string, path: string): boolean | undefined {
    const fieldPath = childPath(path, key);
    const value = obj[key];
    if (value === undefined) return this.missing(fieldPath);
    if (typeof value !== 'boolean') return this.invalid(fieldPath, 'must be true or false');
    return value;
  }

  oneOf<T extends string>(obj: Obj, key: string, path: string, options: readonly T[]): T | undefined {
    const fieldPath = childPath(path, key);
    const value = obj[key];
    if (value === undefined) return this.missing(fieldPath);
    if (typeof value !== 'string' || !(options as readonly string[]).includes(value)) {
      return this.invalid(fieldPath, `must be one of: ${options.join(', ')}`);
    }
    return value as T;
  }

  array(obj: Obj, key: string, path: string): unknown[] | undefined {
    const fieldPath = childPath(path, key);
    const value = obj[key];
    if (value === undefined) return this.missing(fieldPath);
    if (!Array.isArray(value)) return this.invalid(fieldPath, 'must be a list');
    return value;
  }

  private missing(path: string): undefined {
    this.error(path, 'is required');
    return undefined;
  }

  private invalid(path: string, message: string): undefined {
    this.error(path, message);
    return undefined;
  }
}
