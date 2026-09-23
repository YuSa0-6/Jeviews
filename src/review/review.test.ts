import { describe, expect, it } from 'vitest';
import { CHECKS, type Check, questionId } from './checks.js';
import { fileKind } from './file-kind.js';
import type { CheckResult } from './output.js';
import { type Provider, ProviderError, type Question, type StaticAnalyzer } from './ports.js';
import { reviewAll } from './review.js';
import { checkVerdict, DEFAULT_THRESHOLDS, fileVerdict } from './verdict.js';

const T = DEFAULT_THRESHOLDS;

describe('checkVerdict', () => {
  it('problem at or above high is NG regardless of needsContext', () => {
    expect(checkVerdict(0.65, 0.99, T).verdict).toBe('NG');
    expect(checkVerdict(0.9, 0.0, T).verdict).toBe('NG');
    expect(checkVerdict(0.7, 0.0, T, 'lint').verdict).not.toBe('NG');
    expect(checkVerdict(0.8, 0.0, T, 'lint').verdict).toBe('NG');
    expect(checkVerdict(0.7, 0.0, T, 'formatting').verdict).toBe('NG');
  });
  it('needsContext at or above high is NEED_REVIEW when problem is below high', () => {
    expect(checkVerdict(0.1, 0.65, T)).toEqual({
      verdict: 'NEED_REVIEW',
      reason: 'needs_context',
    });
  });
  it('problem between low and high is NEED_REVIEW as uncertain', () => {
    expect(checkVerdict(0.5, 0.1, T)).toEqual({
      verdict: 'NEED_REVIEW',
      reason: 'uncertain',
    });
    expect(checkVerdict(0.36, 0.1, T).reason).toBe('uncertain');
  });
  it('problem at or below low with low needsContext is GOOD', () => {
    expect(checkVerdict(0.35, 0.2, T).verdict).toBe('GOOD');
    expect(checkVerdict(0.0, 0.0, T).verdict).toBe('GOOD');
  });
});

describe('fileVerdict', () => {
  const mk = (verdict: CheckResult['verdict'], opts: { applicable?: boolean; reason?: CheckResult['reason'] } = {}): CheckResult => {
    const r: CheckResult = {
      axisId: 'A',
      group: 'g',
      checkId: 'x',
      questionVersion: '1',
      applicable: opts.applicable ?? true,
      problem: null,
      needsContext: null,
      verdict,
    };
    if (opts.reason) r.reason = opts.reason;
    return r;
  };
  it('any NG wins', () => {
    expect(fileVerdict([mk('GOOD'), mk('NEED_REVIEW', { reason: 'needs_context' }), mk('NG')])).toBe('NG');
  });
  it('needs_context and input_too_large escalate to NEED_REVIEW', () => {
    expect(fileVerdict([mk('GOOD'), mk('NEED_REVIEW', { reason: 'needs_context' })])).toBe('NEED_REVIEW');
    expect(fileVerdict([mk('GOOD'), mk('NEED_REVIEW', { reason: 'input_too_large' })])).toBe('NEED_REVIEW');
  });
  it('uncertain stays on the check and does not escalate', () => {
    expect(fileVerdict([mk('GOOD'), mk('NEED_REVIEW', { reason: 'uncertain' })])).toBe('GOOD');
  });
  it('all GOOD is GOOD', () => {
    expect(fileVerdict([mk('GOOD'), mk('GOOD')])).toBe('GOOD');
  });
  it('an unanswered applicable check yields null', () => {
    expect(fileVerdict([mk('GOOD'), mk(null, { reason: 'api_error' })])).toBe(null);
  });
  it('no applicable check yields null, not GOOD', () => {
    expect(fileVerdict([mk(null, { applicable: false, reason: 'not_applicable' })])).toBe(null);
    expect(fileVerdict([])).toBe(null);
  });
});

describe('fileKind', () => {
  it('classifies by extension and basename', () => {
    expect(fileKind('src/a.ts')).toBe('code');
    expect(fileKind('scripts/run.sh')).toBe('code');
    expect(fileKind('src/a.test.ts')).toBe('test');
    expect(fileKind('src/a.spec.js')).toBe('test');
    expect(fileKind('src/test-utils.ts')).toBe('code');
    expect(fileKind('spec/models/account_spec.rb')).toBe('test');
    expect(fileKind('test/models/account_test.rb')).toBe('test');
    expect(fileKind('spec/rails_helper.rb')).toBe('test');
    expect(fileKind('spec/fixtures/user.json')).toBe('test');
    expect(fileKind('pkg/handler_test.go')).toBe('test');
    expect(fileKind('tests/test_api.py')).toBe('test');
    expect(fileKind('src/__tests__/a.ts')).toBe('test');
    expect(fileKind('app/models/contest.rb')).toBe('code');
    expect(fileKind('app/services/testing_service.rb')).toBe('code');
    expect(fileKind('package.json')).toBe('config');
    expect(fileKind('.gitignore')).toBe('config');
    expect(fileKind('.env.example')).toBe('template');
    expect(fileKind('.env.production.sample')).toBe('template');
    expect(fileKind('config/database.yml.example')).toBe('template');
    expect(fileKind('.env.production')).toBe('config');
    expect(fileKind('docs/README.md')).toBe('doc');
    expect(fileKind('LICENSE')).toBe('other');
  });
});

function fakeProvider(answer: (q: string) => number, opts: { attempts?: number; usage?: boolean } = {}): Provider {
  return {
    model: 'fake',
    usdPerInputToken: 0.042 / 1_000_000,
    async ask(_state: unknown, questions: Record<string, Question>) {
      const answers: Record<string, { type: 'noul'; noul: number }> = {};
      for (const id of Object.keys(questions)) answers[id] = { type: 'noul', noul: answer(id) };
      const response: {
        model: string;
        answers: typeof answers;
        usage?: { input_tokens: number; output_tokens: number };
      } = {
        model: 'fake',
        answers,
      };
      if (opts.usage !== false) response.usage = { input_tokens: 100, output_tokens: 10 };
      return { response, attempts: opts.attempts ?? 1 };
    },
  };
}

const file = (path: string, content: string) => ({
  path,
  content,
  bytes: Buffer.byteLength(content),
  revision: 'r',
});

/** 軸ごとの失敗を試すための、軸を 2 つに絞った確認項目。 */
const TWO_AXIS_CHECKS: readonly Check[] = [
  {
    id: 'a_check',
    group: 'input_validation',
    axisId: 'A',
    appliesTo: ['code'],
    questionVersion: 'test',
    problem: 'problem A',
    needsContext: 'needs context A',
  },
  {
    id: 'b_check',
    group: 'secret_exposure',
    axisId: 'B',
    appliesTo: ['code'],
    questionVersion: 'test',
    problem: 'problem B',
    needsContext: 'needs context B',
  },
];

/** 指定した確認項目の質問が含まれる呼び出しだけ失敗させる provider。 */
function axisFailingProvider(failingCheckIds: readonly string[]): Provider {
  const inner = fakeProvider(() => 0.05);
  return {
    ...inner,
    async ask(state, questions) {
      const ids = Object.keys(questions);
      if (failingCheckIds.some((checkId) => ids.some((id) => id.startsWith(`${checkId}__`)))) {
        const e = new ProviderError('server', 'boom', 500) as ProviderError & { attempts?: number };
        e.attempts = 2;
        throw e;
      }
      return inner.ask(state, questions);
    },
  };
}

describe('reviewAll', () => {
  it('maps answers to per-check results and aggregates per file', async () => {
    const provider = fakeProvider((id) => (id === questionId('secret_hardcoded', 'problem') ? 0.9 : 0.05));
    const out = await reviewAll({
      providerId: 'typesafe',
      provider,
      model: 'fake',
      snapshotId: 'snap',
      files: [file('a.ts', 'const x = 1;')],
      exclusions: [],
    });
    expect(out.run.status).toBe('completed');
    const f = out.files[0]!;
    expect(f.kind).toBe('code');
    expect(f.verdict).toBe('NG');
    expect(f.checks).toHaveLength(CHECKS.length);
    expect(f.checks.every((c) => c.applicable)).toBe(true);
    const secret = f.checks.find((c) => c.checkId === 'secret_hardcoded')!;
    expect(secret.verdict).toBe('NG');
    expect(secret.group).toBe('secret_exposure');
    expect(secret.problem).toEqual({ probability: 0.9 });
    expect(f.checks.find((c) => c.checkId === 'lint_unused_import')!.verdict).toBe('GOOD');
    const axes = new Set(CHECKS.map((check) => check.axisId)).size;
    expect(out.run.usage).toEqual({
      requests: axes,
      inputTokens: axes * 100,
      outputTokens: axes * 10,
      costUsd: axes * 0.0000042,
    });
  });

  it('asks one judgment axis at a time', async () => {
    const batches: string[][] = [];
    const inner = fakeProvider(() => 0);
    const provider: Provider = {
      ...inner,
      async ask(state, questions) {
        batches.push(Object.keys(questions));
        return inner.ask(state, questions);
      },
    };
    await reviewAll({
      providerId: 'typesafe',
      provider,
      model: 'fake',
      snapshotId: 'snap',
      files: [file('a.ts', 'x')],
      exclusions: [],
    });

    const axisByCheck = new Map(CHECKS.map((check) => [check.id, check.axisId]));
    expect(batches).toHaveLength(new Set(CHECKS.map((check) => check.axisId)).size);
    for (const batch of batches) {
      const axes = new Set(batch.map((id) => axisByCheck.get(id.split('__')[0]!)));
      expect(axes.size).toBe(1);
    }
  });

  it('sends only applicable questions for config files and marks the rest not_applicable', async () => {
    let sent: string[] = [];
    const inner = fakeProvider(() => 0.05);
    const provider: Provider = {
      model: 'fake',
      usdPerInputToken: 0.042 / 1_000_000,
      async ask(state, questions) {
        sent.push(...Object.keys(questions));
        return inner.ask(state, questions);
      },
    };
    const out = await reviewAll({
      providerId: 'typesafe',
      provider,
      model: 'fake',
      snapshotId: 'snap',
      files: [file('package.json', '{}')],
      exclusions: [],
    });
    const f = out.files[0]!;
    expect(f.kind).toBe('config');
    expect(sent.some((q) => q.startsWith('input_'))).toBe(false);
    expect(sent.some((q) => q.startsWith('format_'))).toBe(true);
    expect(sent.some((q) => q.startsWith('secret_'))).toBe(true);
    const na = f.checks.filter((c) => !c.applicable);
    expect(na.length).toBeGreaterThan(0);
    expect(na.every((c) => c.reason === 'not_applicable' && c.verdict === null && c.problem === null)).toBe(true);
    expect(f.verdict).toBe('GOOD');
    expect(f.checks).toHaveLength(CHECKS.length);
  });

  it('uncertain checks do not make the file NEED_REVIEW', async () => {
    const out = await reviewAll({
      providerId: 'typesafe',
      provider: fakeProvider((id) => (id.endsWith('__problem') ? 0.5 : 0.1)),
      model: 'fake',
      snapshotId: 'snap',
      files: [file('a.ts', 'x')],
      exclusions: [],
    });
    const f = out.files[0]!;
    expect(f.checks.every((c) => c.reason === 'uncertain')).toBe(true);
    expect(f.verdict).toBe('GOOD');
  });

  it('does not send oversized files and marks applicable checks NEED_REVIEW with input_too_large', async () => {
    let calls = 0;
    const provider: Provider = {
      model: 'fake',
      usdPerInputToken: 0.042 / 1_000_000,
      async ask() {
        calls += 1;
        throw new Error('should not be called');
      },
    };
    const out = await reviewAll({
      providerId: 'typesafe',
      provider,
      model: 'fake',
      snapshotId: 'snap',
      files: [file('big.ts', 'x'.repeat(100))],
      exclusions: [],
      maxStateBytes: 50,
    });
    expect(calls).toBe(0);
    const f = out.files[0]!;
    expect(f.verdict).toBe('NEED_REVIEW');
    expect(f.checks.filter((c) => c.applicable).every((c) => c.reason === 'input_too_large' && c.problem === null)).toBe(true);
    expect(out.run.status).toBe('completed');
  });

  it('records a per-file API error, keeps verdict null, continues, and reports partial', async () => {
    let n = 0;
    const good = fakeProvider(() => 0.0);
    const provider: Provider = {
      model: 'fake',
      usdPerInputToken: 0.042 / 1_000_000,
      async ask(state, questions) {
        n += 1;
        if ((state as { path: string }).path === 'bad.ts') {
          const e = new ProviderError('server', 'boom', 500) as ProviderError & { attempts?: number };
          e.attempts = 3;
          throw e;
        }
        return good.ask(state, questions);
      },
    };
    const out = await reviewAll({
      providerId: 'typesafe',
      provider,
      model: 'fake',
      snapshotId: 'snap',
      files: [file('bad.ts', 'a'), file('ok.ts', 'b')],
      exclusions: [{ path: 'img.png', reason: 'binary' }],
      concurrency: 1,
    });
    // 軸ごとに失敗を隔離するので、失敗するファイルでも全軸に問い合わせる (4 軸 + ok.ts の 4 軸)。
    expect(n).toBe(8);
    expect(out.run.status).toBe('partial');
    const bad = out.files.find((f) => f.path === 'bad.ts')!;
    expect(bad.verdict).toBe(null);
    expect(bad.error?.code).toBe('server');
    expect(bad.checks.filter((c) => c.applicable).every((c) => c.reason === 'api_error')).toBe(true);
    expect(out.files.find((f) => f.path === 'ok.ts')!.verdict).toBe('GOOD');
    // bad.ts は 4 軸すべてが attempts=3 で失敗し 12、ok.ts は 4 軸 x 1 で 4。
    expect(out.run.usage.requests).toBe(16);
    expect(out.exclusions).toEqual([{ path: 'img.png', reason: 'binary' }]);
  });

  it('keeps answers from axes that succeeded when one axis fails', async () => {
    const out = await reviewAll({
      providerId: 'typesafe',
      provider: axisFailingProvider(['b_check']),
      model: 'fake',
      snapshotId: 'snap',
      files: [file('a.ts', 'x')],
      exclusions: [],
      checks: TWO_AXIS_CHECKS,
    });
    const f = out.files[0]!;
    const a = f.checks.find((c) => c.checkId === 'a_check')!;
    const b = f.checks.find((c) => c.checkId === 'b_check')!;
    expect(a.verdict).not.toBe(null);
    expect(a.reason).not.toBe('api_error');
    expect(b.verdict).toBe(null);
    expect(b.reason).toBe('api_error');
    expect(f.error?.code).toBe('server');
    expect(out.run.status).toBe('partial');
    // 成功した軸の 1 回と、失敗した軸の attempts=2。
    expect(out.run.usage.requests).toBe(3);
  });

  it('falls back to the existing failure path when every axis fails', async () => {
    const out = await reviewAll({
      providerId: 'typesafe',
      provider: axisFailingProvider(['a_check', 'b_check']),
      model: 'fake',
      snapshotId: 'snap',
      files: [file('a.ts', 'x')],
      exclusions: [],
      checks: TWO_AXIS_CHECKS,
    });
    const f = out.files[0]!;
    expect(f.verdict).toBe(null);
    expect(f.checks.filter((c) => c.applicable).every((c) => c.verdict === null && c.reason === 'api_error')).toBe(true);
    expect(f.error?.code).toBe('server');
    expect(out.run.status).toBe('partial');
    // 2 軸ともに attempts=2 で失敗する。
    expect(out.run.usage.requests).toBe(4);
  });

  it('nulls usage when the provider does not report tokens', async () => {
    const out = await reviewAll({
      providerId: 'typesafe',
      provider: fakeProvider(() => 0, { usage: false }),
      model: 'fake',
      snapshotId: 'snap',
      files: [file('a.ts', 'a')],
      exclusions: [],
    });
    expect(out.run.usage.inputTokens).toBe(null);
    expect(out.run.usage.costUsd).toBe(null);
    expect(out.run.usage.requests).toBe(new Set(CHECKS.map((check) => check.axisId)).size);
  });

  it('uses static results and sends only unresolved checks to the provider', async () => {
    let sent: string[] = [];
    const inner = fakeProvider(() => 0);
    const provider: Provider = {
      ...inner,
      async ask(state, questions) {
        sent.push(...Object.keys(questions));
        return inner.ask(state, questions);
      },
    };
    const analyzer: StaticAnalyzer = {
      id: 'fixture',
      async analyze() {
        return {
          'a.ts': {
            secret_hardcoded: {
              verdict: 'NG',
              source: 'fixture',
              detail: 'line 1',
            },
          },
        };
      },
    };
    const out = await reviewAll({
      providerId: 'typesafe',
      provider,
      model: 'fake',
      snapshotId: 'snap',
      files: [file('a.ts', 'x')],
      exclusions: [],
      analyzers: [analyzer],
    });
    const result = out.files[0]!.checks.find((check) => check.checkId === 'secret_hardcoded')!;
    expect(sent.some((id) => id.startsWith('secret_hardcoded__'))).toBe(false);
    expect(result).toMatchObject({
      verdict: 'NG',
      problem: null,
      needsContext: null,
      evidence: { source: 'fixture' },
    });
  });

  it('keeps the first analyzer result and logs the duplicate', async () => {
    const logs: string[] = [];
    const mkAnalyzer = (id: string, source: string): StaticAnalyzer => ({
      id,
      async analyze() {
        return {
          'a.ts': {
            secret_hardcoded: { verdict: 'NG' as const, source },
          },
        };
      },
    });
    const out = await reviewAll({
      providerId: 'typesafe',
      provider: fakeProvider(() => 0),
      model: 'fake',
      snapshotId: 'snap',
      files: [file('a.ts', 'x')],
      exclusions: [],
      analyzers: [mkAnalyzer('first', 'first-source'), mkAnalyzer('second', 'second-source')],
      log: (line) => logs.push(line),
    });
    const result = out.files[0]!.checks.find((check) => check.checkId === 'secret_hardcoded')!;
    expect(result.evidence).toEqual({ source: 'first-source' });
    expect(logs.filter((line) => line.startsWith('analyzer second:'))).toEqual([
      'analyzer second: a.ts/secret_hardcoded は first-source の判定を優先します',
    ]);
  });

  it('keeps the static NG on the file verdict when the provider call fails', async () => {
    const analyzer: StaticAnalyzer = {
      id: 'fixture',
      async analyze() {
        return {
          'a.ts': {
            secret_hardcoded: { verdict: 'NG' as const, source: 'fixture' },
          },
        };
      },
    };
    const provider: Provider = {
      model: 'fake',
      usdPerInputToken: 0.042 / 1_000_000,
      async ask() {
        throw new ProviderError('server', 'boom', 500);
      },
    };
    const out = await reviewAll({
      providerId: 'typesafe',
      provider,
      model: 'fake',
      snapshotId: 'snap',
      files: [file('a.ts', 'x'), file('b.ts', 'y')],
      exclusions: [],
      analyzers: [analyzer],
      concurrency: 1,
    });
    expect(out.run.status).toBe('partial');
    const withStatic = out.files.find((f) => f.path === 'a.ts')!;
    expect(withStatic.verdict).toBe('NG');
    expect(withStatic.error?.code).toBe('server');
    // 静的解析の結果が無いファイルは従来どおり判定しない。
    const withoutStatic = out.files.find((f) => f.path === 'b.ts')!;
    expect(withoutStatic.verdict).toBe(null);
    expect(withoutStatic.error?.code).toBe('server');
  });

  it('falls back to the provider when an analyzer fails', async () => {
    const logs: string[] = [];
    const analyzer: StaticAnalyzer = {
      id: 'broken',
      async analyze() {
        throw new Error('unavailable');
      },
    };
    const out = await reviewAll({
      providerId: 'typesafe',
      provider: fakeProvider(() => 0),
      model: 'fake',
      snapshotId: 'snap',
      files: [file('a.ts', 'x')],
      exclusions: [],
      analyzers: [analyzer],
      log: (line) => logs.push(line),
    });
    expect(out.files[0]!.verdict).toBe('GOOD');
    expect(out.run.usage.requests).toBe(new Set(CHECKS.map((check) => check.axisId)).size);
    expect(logs).toContain('analyzer broken: unavailable');
  });
});
