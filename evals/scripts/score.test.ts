import { describe, expect, it } from 'vitest';
import { score } from './score.mjs';

const check = (checkId, verdict, reason) => ({ checkId, applicable: true, verdict, ...(reason ? { reason } : {}) });
const na = (checkId) => ({ checkId, applicable: false, verdict: null });

describe('score', () => {
  it('counts tp / fp / fn / tn per check and agreement on covered files', () => {
    const expected = { files: {
      'a.ts': { lint_unused_import: { truth: 'problem' }, lint_unused_param: { truth: 'clean' } },
      'b.ts': { lint_unused_import: { truth: 'clean' }, lint_unused_param: { truth: 'clean' } },
      'c.ts': { lint_unused_import: { truth: 'clean' } },
    } };
    const output = { files: [
      { path: 'a.ts', verdict: 'NG', checks: [check('lint_unused_import', 'NG'), check('lint_unused_param', 'GOOD'), check('error_empty_catch', 'GOOD')] },
      { path: 'b.ts', verdict: 'NG', checks: [check('lint_unused_import', 'NG'), check('lint_unused_param', 'GOOD')] },
      { path: 'c.ts', verdict: 'NEED_REVIEW', checks: [check('lint_unused_import', 'NEED_REVIEW', 'needs_context'), na('lint_unused_param')] },
    ] };
    const s = score(expected, output);
    expect(s.checks.lint_unused_import).toMatchObject({ tp: 1, fp: 1, fn: 0, tn: 0, abstain: 1 });
    expect(s.checks.lint_unused_param).toMatchObject({ tp: 0, fp: 0, fn: 0, tn: 2 });
    expect(s.checks.lint_unused_import.precision).toBeCloseTo(0.5);
    expect(s.covered).toBe(2);
    expect(s.coveredOk).toBe(1);
    expect(s.known).toBe(2);
    expect(s.agree).toBe(1);
    expect(s.needReviewRate).toBeCloseTo(1 / 3);
  });

  it('ignores files with no applicable checks', () => {
    const s = score({ files: {} }, { files: [{ path: 'x', verdict: null, checks: [na('lint_unused_import')] }] });
    expect(s.covered).toBe(0);
    expect(s.known).toBe(0);
  });
});
