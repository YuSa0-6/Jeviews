import { describe, expect, it } from 'vitest';
import { CHECKS, questionId } from './checks.js';
import { fileKind } from './file-kind.js';
import type { CheckResult } from './output.js';
import { ProviderError, type Provider, type Question } from './ports.js';
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
    expect(checkVerdict(0.1, 0.65, T)).toEqual({ verdict: 'NEED_REVIEW', reason: 'needs_context' });
  });
  it('problem between low and high is NEED_REVIEW as uncertain', () => {
    expect(checkVerdict(0.5, 0.1, T)).toEqual({ verdict: 'NEED_REVIEW', reason: 'uncertain' });
    expect(checkVerdict(0.36, 0.1, T).reason).toBe('uncertain');
  });
  it('problem at or below low with low needsContext is GOOD', () => {
    expect(checkVerdict(0.35, 0.2, T).verdict).toBe('GOOD');
    expect(checkVerdict(0.0, 0.0, T).verdict).toBe('GOOD');
  });
});

describe('fileVerdict', () => {
  const mk = (
    verdict: CheckResult['verdict'],
    opts: { applicable?: boolean; reason?: CheckResult['reason'] } = {},
  ): CheckResult => {
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
      const response: { model: string; answers: typeof answers; usage?: { input_tokens: number; output_tokens: number } } = {
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
    expect(out.run.usage).toEqual({ requests: 1, inputTokens: 100, outputTokens: 10, costUsd: 0.0000042 });
  });

  it('sends only applicable questions for config files and marks the rest not_applicable', async () => {
    let sent: string[] = [];
    const inner = fakeProvider(() => 0.05);
    const provider: Provider = {
      model: 'fake',
      usdPerInputToken: 0.042 / 1_000_000,
      async ask(state, questions) {
        sent = Object.keys(questions);
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
    expect(n).toBe(2);
    expect(out.run.status).toBe('partial');
    const bad = out.files.find((f) => f.path === 'bad.ts')!;
    expect(bad.verdict).toBe(null);
    expect(bad.error?.code).toBe('server');
    expect(bad.checks.filter((c) => c.applicable).every((c) => c.reason === 'api_error')).toBe(true);
    expect(out.files.find((f) => f.path === 'ok.ts')!.verdict).toBe('GOOD');
    expect(out.run.usage.requests).toBe(4);
    expect(out.exclusions).toEqual([{ path: 'img.png', reason: 'binary' }]);
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
    expect(out.run.usage.requests).toBe(1);
  });
});
