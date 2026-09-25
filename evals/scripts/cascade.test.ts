import { describe, expect, it } from 'vitest';
import { cascade, escalates, mechanical, reliability } from './cascade.mjs';

const check = (checkId, group, p, verdict, reason) => ({
  checkId,
  group,
  applicable: true,
  problem: p === null ? null : { probability: p },
  verdict,
  ...(reason ? { reason } : {}),
});
const file = (path, bytes, checks) => ({ path, bytes, checks });

describe('escalates', () => {
  it('sends a file when an input / error / secret check is above low, NG, or needs context', () => {
    expect(escalates(file('a', 1, [check('input_unchecked_use', 'input_validation', 0.4, 'NEED_REVIEW', 'uncertain')]), 0.35)).toBe(true);
    expect(escalates(file('a', 1, [check('error_empty_catch', 'error_handling', 0.1, 'NG')]), 0.35)).toBe(true);
    expect(escalates(file('a', 1, [check('secret_logged', 'secret_exposure', 0.2, 'NEED_REVIEW', 'needs_context')]), 0.35)).toBe(true);
    expect(escalates(file('a', 1, [check('input_unchecked_use', 'input_validation', 0.3, 'GOOD')]), 0.35)).toBe(false);
  });

  it('leaves mechanical checks to the tools and sends files Jev could not read', () => {
    expect(escalates(file('a', 1, [check('lint_unused_param', 'lint', 0.9, 'NG')]), 0.35)).toBe(false);
    expect(escalates(file('a', 1, [check('format_quotes', 'formatting', null, 'NEED_REVIEW', 'input_too_large')]), 0.35)).toBe(true);
  });
});

describe('cascade', () => {
  it('counts files, bytes and expected problems on the side sent to the LLM', () => {
    const expected = { files: {
      'a.ts': { error_empty_catch: { truth: 'problem', source: 'codex' } },
      'b.ts': { input_unchecked_use: { truth: 'problem', source: 'codex' }, lint_unused_param: { truth: 'problem', source: 'tsc' } },
    } };
    const output = { files: [
      file('a.ts', 100, [check('error_empty_catch', 'error_handling', 0.5, 'NEED_REVIEW', 'uncertain')]),
      file('b.ts', 300, [check('input_unchecked_use', 'input_validation', 0.1, 'GOOD'), check('lint_unused_param', 'lint', 0.9, 'NG')]),
      file('c.ts', 600, [check('error_empty_catch', 'error_handling', 0.02, 'GOOD')]),
    ] };
    expect(cascade(expected, output, 0.35)).toEqual({ files: 3, bytes: 1000, problems: 2, sentFiles: 1, sentBytes: 100, keptProblems: 1 });
    expect(cascade(expected, output, 0.05)).toMatchObject({ sentFiles: 2, keptProblems: 2 });
  });
});

describe('reliability', () => {
  it('bins input / error / secret checks by probability and counts expected problems', () => {
    const expected = { files: { 'a.ts': { error_empty_catch: { truth: 'problem' } } } };
    const output = { files: [
      file('a.ts', 1, [
        check('error_empty_catch', 'error_handling', 0.9, 'NG'),
        check('input_unchecked_use', 'input_validation', 0.05, 'GOOD'),
        check('lint_unused_param', 'lint', 0.5, 'GOOD'),
      ]),
    ] };
    const bins = reliability(expected, output);
    expect(bins[0]).toMatchObject({ lo: 0, pairs: 1, problems: 0 });
    expect(bins.at(-1)).toMatchObject({ lo: 0.8, pairs: 1, problems: 1 });
    expect(bins.reduce((s, b) => s + b.pairs, 0)).toBe(2);
  });
});

describe('mechanical', () => {
  it('scores Jev and the LLM only on tool-labelled checks that Jev judged', () => {
    const expected = { files: {
      'a.ts': {
        lint_unused_param: { truth: 'problem', source: 'tsc' },
        lint_unused_import: { truth: 'clean', source: 'tsc' },
        complexity_branchy_function: { truth: 'problem', source: 'codex' },
      },
      'big.py': { lint_unused_import: { truth: 'problem', source: 'ruff' } },
    } };
    const output = { files: [
      file('a.ts', 1, [
        check('lint_unused_param', 'lint', 0.2, 'GOOD'),
        check('lint_unused_import', 'lint', 0.1, 'GOOD'),
        check('complexity_branchy_function', 'complexity', 0.9, 'NG'),
      ]),
      file('big.py', 1, [check('lint_unused_import', 'lint', null, 'NEED_REVIEW', 'input_too_large')]),
    ] };
    const llm = { 'a.ts': { lint_unused_param: {}, lint_unused_import: {} } };
    expect(mechanical(expected, output, llm)).toEqual({ jev: { tp: 0, fn: 1, fp: 0 }, llm: { tp: 1, fn: 0, fp: 1 } });
  });
});
