import { describe, expect, it } from 'vitest';
import { parseYaml } from '../../../src/engine/config/parse';

describe('parseYaml', () => {
  it('returns the parsed value for valid YAML', () => {
    // Plan: parse a small document with a nested map and a list.
    // Verifies: the result is ok and holds the same plain JavaScript value.
    const result = parseYaml('a: 1\nb: { c: [x, y] }\n');
    expect(result).toEqual({ ok: true, value: { a: 1, b: { c: ['x', 'y'] } } });
  });

  it('reports a syntax error with its line instead of throwing', () => {
    // Plan: parse a document whose third line nests a mapping inside a compact mapping ("c: d: e").
    // Verifies: the result is an error for the whole document, and the message names line 3.
    const result = parseYaml('a: 1\nb: 2\nc: d: e\n');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.path).toBe('');
    expect(result.errors[0]?.message).toMatch(/line 3/);
  });

  it('rejects duplicate keys', () => {
    // Plan: parse a map that defines the same key twice.
    // Verifies: the duplicate is an error, not silently resolved to one of the values.
    const result = parseYaml('workers: 1\nworkers: 2\n');
    expect(result.ok).toBe(false);
  });
});
