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
        { path: 'problem.ts', content: `${problem}\n${branchy}`, bytes: Buffer.byteLength(`${problem}\n${branchy}`), revision: 'problem' },
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
});
