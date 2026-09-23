import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTypeScriptAnalyzer, normalizePath } from './typescript.js';

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
    const branchy = `export function branchy(value: number) {
${Array.from({ length: 15 }, (_, index) => `  if (value === ${index}) return ${index};`).join('\n')}
  return value;
}`;
    const uncertain = `export function uncertain(value: number) {
${Array.from({ length: 9 }, (_, index) => `  if (value === ${index}) return ${index};`).join('\n')}
  return value;
}`;
    try {
      const dependency = 'export const dependency = 1;';
      await writeFile(join(cwd, 'dependency.ts'), dependency);
      await writeFile(join(cwd, 'problem.ts'), `${problem}\n${branchy}`);
      await writeFile(join(cwd, 'clean.ts'), clean);
      await writeFile(join(cwd, 'uncertain.ts'), uncertain);
      const analyzer = createTypeScriptAnalyzer({ cwd });
      const result = await analyzer.analyze([
        {
          path: 'problem.ts',
          content: `${problem}\n${branchy}`,
          bytes: Buffer.byteLength(`${problem}\n${branchy}`),
          revision: 'problem',
        },
        { path: 'clean.ts', content: clean, bytes: Buffer.byteLength(clean), revision: 'clean' },
        { path: 'uncertain.ts', content: uncertain, bytes: Buffer.byteLength(uncertain), revision: 'uncertain' },
        { path: 'dependency.ts', content: dependency, bytes: Buffer.byteLength(dependency), revision: 'dependency' },
      ]);

      expect(result['problem.ts']?.lint_unused_param).toMatchObject({ verdict: 'NG', source: 'typescript' });
      expect(result['problem.ts']?.lint_unused_variable).toMatchObject({ verdict: 'NG', source: 'typescript' });
      expect(result['problem.ts']?.lint_unused_import).toMatchObject({ verdict: 'NG', source: 'typescript' });
      expect(result['problem.ts']?.complexity_branchy_function).toEqual({
        verdict: 'NG',
        source: 'fallow',
        detail: 'max cyclomatic 16',
      });
      expect(result['clean.ts']).toEqual({
        lint_unused_import: { verdict: 'GOOD', source: 'typescript' },
        lint_unused_variable: { verdict: 'GOOD', source: 'typescript' },
        lint_unused_param: { verdict: 'GOOD', source: 'typescript' },
        complexity_branchy_function: { verdict: 'GOOD', source: 'fallow' },
      });
      expect(result['uncertain.ts']?.complexity_branchy_function).toBeUndefined();
      // fallow が複雑度を測っていないファイルは GOOD にせず provider の判定へ戻す
      expect(result['dependency.ts']?.lint_unused_variable).toMatchObject({ verdict: 'GOOD', source: 'typescript' });
      expect(result['dependency.ts']?.complexity_branchy_function).toBeUndefined();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('reports a skipped complexity run instead of silently dropping it', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'jeviews-typescript-'));
    const clean = 'export function double(value: number) { const result = value * 2; return result; }';
    const lines: string[] = [];
    try {
      await writeFile(join(cwd, 'clean.ts'), clean);
      const analyzer = createTypeScriptAnalyzer({
        cwd,
        fallowPath: join(cwd, 'fallow-not-installed.js'),
        log: (line) => lines.push(line),
      });
      const result = await analyzer.analyze([
        { path: 'clean.ts', content: clean, bytes: Buffer.byteLength(clean), revision: 'clean' },
      ]);

      expect(result['clean.ts']?.lint_unused_variable).toMatchObject({ verdict: 'GOOD', source: 'typescript' });
      expect(result['clean.ts']?.complexity_branchy_function).toBeUndefined();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('typescript analyzer: fallow complexity をスキップしました');
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
        complexity_branchy_function: { verdict: 'GOOD', source: 'fallow' },
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

  it('normalizes diagnostic paths against cwd', () => {
    expect(normalizePath('./src/a.ts', '/repo')).toBe('src/a.ts');
    expect(normalizePath('/repo/src/a.ts', '/repo')).toBe('src/a.ts');
    expect(normalizePath('src\\a.ts', '/repo')).toBe('src/a.ts');
  });

  it('reports the bundled tool versions and omits the ones that are overridden', () => {
    expect(createTypeScriptAnalyzer({ cwd: '/repo' }).version).toMatch(/^tsc@\d+\.\d+\.\d+\+fallow@\d+\.\d+\.\d+$/);
    expect(createTypeScriptAnalyzer({ cwd: '/repo', tscPath: '/custom/tsc' }).version).toMatch(/^fallow@/);
    expect(createTypeScriptAnalyzer({ cwd: '/repo', fallowPath: '/custom/fallow' }).version).toMatch(/^tsc@[^+]+$/);
    expect(
      createTypeScriptAnalyzer({ cwd: '/repo', tscPath: '/custom/tsc', fallowPath: '/custom/fallow' }).version,
    ).toBeUndefined();
  });
});
