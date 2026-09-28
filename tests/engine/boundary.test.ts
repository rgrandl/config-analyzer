// Enforces the engine boundary (DESIGN.md §3): code under src/engine/ is pure TypeScript.
// It may import other engine files and non-UI packages, but never React, charting, or anything
// outside src/engine/ (such as src/ui/ or src/demo/). Inside the engine, the analyzer and the simulator
// never import each other; what they share lives in config/.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ENGINE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/engine');
const FORBIDDEN_PACKAGES = ['react', 'react-dom', 'recharts'];

// Matches `import ... from 'x'`, `export ... from 'x'`, `import 'x'` and `import('x')`.
const IMPORT_PATTERN = /(?:from\s+|import\s*\(?\s*)['"]([^'"]+)['"]/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** The analyzer and the simulator are independent; both may use config/. */
const SEPARATE_AREAS = ['analyzer', 'simulator'];

function areaOf(path: string): string | undefined {
  return relative(ENGINE_DIR, path).split(/[\\/]/)[0];
}

export function boundaryViolations(file: string, source: string): string[] {
  const violations: string[] = [];
  for (const match of source.matchAll(IMPORT_PATTERN)) {
    const specifier = match[1] ?? '';
    if (specifier.startsWith('.')) {
      const target = resolve(dirname(file), specifier);
      if (relative(ENGINE_DIR, target).startsWith('..')) violations.push(`imports outside the engine: ${specifier}`);
      const [from, to] = [areaOf(file), areaOf(target)];
      if (from !== to && SEPARATE_AREAS.includes(from ?? '') && SEPARATE_AREAS.includes(to ?? '')) {
        violations.push(`${from} imports ${to}: ${specifier}`);
      }
    } else {
      const pkg = specifier.split('/')[0] ?? '';
      if (FORBIDDEN_PACKAGES.includes(pkg)) violations.push(`imports a UI package: ${specifier}`);
    }
  }
  return violations;
}

describe('engine boundary', () => {
  it('has engine files to check', () => {
    expect(sourceFiles(ENGINE_DIR).length).toBeGreaterThan(0);
  });

  it('no engine file imports UI packages, code outside src/engine/, or across analyzer and simulator', () => {
    const violations = sourceFiles(ENGINE_DIR).flatMap((file) =>
      boundaryViolations(file, readFileSync(file, 'utf8')).map((v) => `${relative(ENGINE_DIR, file)}: ${v}`),
    );
    expect(violations).toEqual([]);
  });

  it('detects violations', () => {
    const file = join(ENGINE_DIR, 'analyzer', 'example.ts');
    expect(boundaryViolations(file, "import { useState } from 'react';")).toHaveLength(1);
    expect(boundaryViolations(file, "import { DEMO_SYSTEM_YAML } from '../../demo';")).toHaveLength(1);
    expect(boundaryViolations(file, "import type { Ms } from '../config/schema';")).toHaveLength(0);
    expect(boundaryViolations(file, "import { parse } from 'yaml';")).toHaveLength(0);
    expect(boundaryViolations(file, "import { simulator } from '../simulator/run';")).toHaveLength(1);
    expect(boundaryViolations(join(ENGINE_DIR, 'simulator', 'x.ts'), "import { exceeds } from '../analyzer/compare';")).toHaveLength(1);
  });
});
