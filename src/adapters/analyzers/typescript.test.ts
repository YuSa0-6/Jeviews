import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTypeScriptAnalyzer } from './typescript.js';

describe('createTypeScriptAnalyzer', () => {
  it('maps compiler unused diagnostics to Jeviews checks', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'jeviews-typescript-'));
    const problem = [
      "import { dependency } from './dependency.js';",
      'export function calculate(unusedParam: number, usedParam: number) {',
      '  const unusedVariable = 1;',
      '  const usedVariable = 2;',
      '  return usedParam + usedVariable;',
      '}',
    ].join('\n');
    const clean = 'export function double(value: number) { const result = value * 2; return result; }';
    try {
      await writeFile(join(cwd, 'dependency.ts'), 'export const dependency = 1;');
      await writeFile(join(cwd, 'problem.ts'), problem);
      await writeFile(join(cwd, 'clean.ts'), clean);
      const analyzer = createTypeScriptAnalyzer({ cwd });
      const result = await analyzer.analyze([
        { path: 'problem.ts', content: problem, bytes: Buffer.byteLength(problem), revision: 'problem' },
        { path: 'clean.ts', content: clean, bytes: Buffer.byteLength(clean), revision: 'clean' },
      ]);

      expect(result['problem.ts']?.lint_unused_param).toMatchObject({ verdict: 'NG', source: 'typescript' });
      expect(result['problem.ts']?.lint_unused_variable).toMatchObject({ verdict: 'NG', source: 'typescript' });
      expect(result['problem.ts']?.lint_unused_import).toMatchObject({ verdict: 'NG', source: 'typescript' });
      expect(result['clean.ts']).toEqual({
        lint_unused_import: { verdict: 'GOOD', source: 'typescript' },
        lint_unused_variable: { verdict: 'GOOD', source: 'typescript' },
        lint_unused_param: { verdict: 'GOOD', source: 'typescript' },
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('omits files tsc could not parse instead of confirming them GOOD', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'jeviews-typescript-'));
    const broken = 'export function f( {\n';
    const clean = 'export function double(value: number) { const result = value * 2; return result; }';
    try {
      await writeFile(join(cwd, 'broken.ts'), broken);
      await writeFile(join(cwd, 'clean.ts'), clean);
      const analyzer = createTypeScriptAnalyzer({ cwd });
      const result = await analyzer.analyze([
        { path: 'broken.ts', content: broken, bytes: Buffer.byteLength(broken), revision: 'broken' },
        { path: 'clean.ts', content: clean, bytes: Buffer.byteLength(clean), revision: 'clean' },
      ]);

      expect(result['broken.ts']).toBeUndefined();
      expect(result['clean.ts']).toEqual({
        lint_unused_import: { verdict: 'GOOD', source: 'typescript' },
        lint_unused_variable: { verdict: 'GOOD', source: 'typescript' },
        lint_unused_param: { verdict: 'GOOD', source: 'typescript' },
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('classifies parameters as params across line breaks and destructuring', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'jeviews-typescript-'));
    const singleLine = 'export function f(unused: number) {\n  return 1;\n}\n';
    const multiLine = 'export function g(\n  unused: number,\n) {\n  return 1;\n}\n';
    const destructured = [
      'interface Opts { a: number; b: number }',
      'export function h({ a, b }: Opts) {',
      '  return b;',
      '}',
      '',
    ].join('\n');
    const variable = 'export function i() {\n  const unused = 1;\n  return 2;\n}\n';
    try {
      await writeFile(join(cwd, 'single.ts'), singleLine);
      await writeFile(join(cwd, 'multi.ts'), multiLine);
      await writeFile(join(cwd, 'destructured.ts'), destructured);
      await writeFile(join(cwd, 'variable.ts'), variable);
      const analyzer = createTypeScriptAnalyzer({ cwd });
      const result = await analyzer.analyze([
        { path: 'single.ts', content: singleLine, bytes: Buffer.byteLength(singleLine), revision: 'single' },
        { path: 'multi.ts', content: multiLine, bytes: Buffer.byteLength(multiLine), revision: 'multi' },
        {
          path: 'destructured.ts',
          content: destructured,
          bytes: Buffer.byteLength(destructured),
          revision: 'destructured',
        },
        { path: 'variable.ts', content: variable, bytes: Buffer.byteLength(variable), revision: 'variable' },
      ]);

      expect(result['single.ts']?.lint_unused_param).toMatchObject({ verdict: 'NG' });
      expect(result['single.ts']?.lint_unused_variable).toMatchObject({ verdict: 'GOOD' });
      expect(result['multi.ts']?.lint_unused_param).toMatchObject({ verdict: 'NG' });
      expect(result['multi.ts']?.lint_unused_variable).toMatchObject({ verdict: 'GOOD' });
      expect(result['destructured.ts']?.lint_unused_param).toMatchObject({ verdict: 'NG' });
      expect(result['destructured.ts']?.lint_unused_variable).toMatchObject({ verdict: 'GOOD' });
      // 変数宣言は引数に流れない。
      expect(result['variable.ts']?.lint_unused_variable).toMatchObject({ verdict: 'NG' });
      expect(result['variable.ts']?.lint_unused_param).toMatchObject({ verdict: 'GOOD' });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
