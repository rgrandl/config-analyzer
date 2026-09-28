// Outcome of parsing or validating user input: a value, or every error found.

export interface ConfigError {
  /** Dotted path to the offending field, e.g. "services.orders.calls[1].timeoutMs"; "" for the whole document. */
  readonly path: string;
  readonly message: string;
}

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly ConfigError[] };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function fail<T>(errors: readonly ConfigError[]): Result<T> {
  return { ok: false, errors };
}
