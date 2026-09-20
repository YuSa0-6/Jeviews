// 共通のレビュー処理。対象ごとに Jev へ問い合わせ、判定し、公開 JSON を組み立てる。
// 依存は引数で渡す。

import { createHash, randomUUID } from 'node:crypto';
import type { Provider, Question } from '../adapters/providers/provider.js';
import { ProviderError } from '../adapters/providers/provider.js';
import type { Exclusion, TrackedFile } from '../adapters/repository/git.js';
import { CHECKS, questionId, type Check } from './checks.js';
import { fileKind } from './file-kind.js';
import type { CheckResult, FileKind, FileResult, ProviderId, ReviewOutput, Thresholds, Usage } from './output.js';
import { checkVerdict, DEFAULT_THRESHOLDS, fileVerdict, runStatus } from './verdict.js';

export interface ReviewDeps {
  provider: Provider;
  providerId: ProviderId;
  model: string;
  snapshotId: string;
  files: TrackedFile[];
  exclusions: Exclusion[];
  thresholds?: Thresholds;
  /** state がこのバイト数を超えるファイルは Jev に送らず NEED_REVIEW にする。 */
  maxStateBytes?: number;
  concurrency?: number;
  checks?: readonly Check[];
  log?: (line: string) => void;
}

/** 仮説: コードは 1 トークン 3 バイト前後。state 上限 32k トークンに対して余裕を取る。 */
export const DEFAULT_MAX_STATE_BYTES = 60_000;

export async function reviewAll(deps: ReviewDeps): Promise<ReviewOutput> {
  const thresholds = deps.thresholds ?? DEFAULT_THRESHOLDS;
  const maxStateBytes = deps.maxStateBytes ?? DEFAULT_MAX_STATE_BYTES;
  const checks = deps.checks ?? CHECKS;
  const log = deps.log ?? (() => {});
  const startedAt = new Date().toISOString();
  const usage: Usage = { requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  let usageComplete = true;

  const results: FileResult[] = new Array(deps.files.length);
  await runLimited(deps.concurrency ?? 4, deps.files, async (file, i) => {
    const kind = fileKind(file.path);
    log(`[${i + 1}/${deps.files.length}] ${file.path} (${file.bytes} bytes, ${kind})`);
    results[i] = await reviewFile(file, kind);
  });

  async function reviewFile(file: TrackedFile, kind: FileKind): Promise<FileResult> {
    const base = { path: file.path, revision: file.revision, bytes: file.bytes, kind };
    const applicable = checks.filter((c) => c.appliesTo.includes(kind));
    const skipped = checks.filter((c) => !c.appliesTo.includes(kind)).map((c) => notApplicable(c));

    if (applicable.length === 0) {
      return { ...base, verdict: fileVerdict(skipped), checks: ordered(checks, skipped) };
    }

    if (file.bytes > maxStateBytes) {
      const cs = [...skipped, ...applicable.map((c) => emptyCheck(c, 'NEED_REVIEW', 'input_too_large'))];
      return { ...base, verdict: fileVerdict(cs), checks: ordered(checks, cs) };
    }

    const state = { path: file.path, content: file.content };
    const questions = buildQuestions(applicable);
    try {
      const { response, attempts } = await deps.provider.ask(state, questions);
      usage.requests += attempts;
      if (typeof response.usage?.input_tokens === 'number') {
        usage.inputTokens! += response.usage.input_tokens;
        usage.outputTokens! += response.usage.output_tokens ?? 0;
      } else {
        usageComplete = false;
      }
      const answered = applicable.map((c) => {
        const p = response.answers[questionId(c.id, 'problem')]?.noul;
        const n = response.answers[questionId(c.id, 'needsContext')]?.noul;
        if (p === undefined || n === undefined) {
          return emptyCheck(c, null, 'api_error');
        }
        const v = checkVerdict(p, n, thresholds);
        const r: CheckResult = {
          axisId: c.axisId,
          group: c.group,
          checkId: c.id,
          questionVersion: c.questionVersion,
          applicable: true,
          problem: { probability: p },
          needsContext: { probability: n },
          verdict: v.verdict,
        };
        if (v.reason) r.reason = v.reason;
        return r;
      });
      const cs = ordered(checks, [...skipped, ...answered]);
      const missing = answered.some((c) => c.verdict === null);
      const result: FileResult = { ...base, verdict: fileVerdict(cs), checks: cs };
      if (missing) result.error = { code: 'invalid_response', message: 'answer missing for some questions' };
      return result;
    } catch (e) {
      const err = e as ProviderError & { attempts?: number };
      usage.requests += err.attempts ?? 1;
      if (err instanceof ProviderError && err.code === 'bad_request') {
        const cs = ordered(checks, [...skipped, ...applicable.map((c) => emptyCheck(c, 'NEED_REVIEW', 'input_too_large'))]);
        return { ...base, verdict: fileVerdict(cs), checks: cs, error: { code: err.code, message: err.message } };
      }
      const cs = ordered(checks, [...skipped, ...applicable.map((c) => emptyCheck(c, null, 'api_error'))]);
      return {
        ...base,
        verdict: null,
        checks: cs,
        error: {
          code: err instanceof ProviderError ? err.code : 'unknown',
          message: err.message ?? String(e),
        },
      };
    }
  }

  const finishedAt = new Date().toISOString();
  const status = runStatus(results);
  if (!usageComplete) {
    usage.inputTokens = null;
    usage.outputTokens = null;
    usage.costUsd = null;
  } else {
    // 単価は接続先が決める。価格が固定でない接続先 (Gateway) では null のまま。
    const price = deps.provider.usdPerInputToken;
    usage.costUsd = price === null ? null : Number(((usage.inputTokens ?? 0) * price).toFixed(8));
  }

  return {
    schemaVersion: 1,
    run: {
      id: randomUUID(),
      scope: 'all',
      mode: 'scan',
      provider: deps.providerId,
      model: deps.model,
      snapshotId: deps.snapshotId,
      policyHash: policyHash(checks, thresholds, deps.model),
      thresholds,
      maxStateBytes,
      status,
      startedAt,
      finishedAt,
      usage,
    },
    files: results,
    exclusions: deps.exclusions,
  };
}

export function buildQuestions(checks: readonly Check[]): Record<string, Question> {
  const q: Record<string, Question> = {};
  for (const c of checks) {
    q[questionId(c.id, 'problem')] = { type: 'noul', instructions: c.problem };
    q[questionId(c.id, 'needsContext')] = { type: 'noul', instructions: c.needsContext };
  }
  return q;
}

export function policyHash(checks: readonly Check[], thresholds: Thresholds, model: string): string {
  return createHash('sha256')
    .update(JSON.stringify({ checks, thresholds, model }))
    .digest('hex')
    .slice(0, 16);
}

/** 公開 JSON では判断基準の定義順に並べる。 */
function ordered(checks: readonly Check[], results: readonly CheckResult[]): CheckResult[] {
  const byId = new Map(results.map((r) => [r.checkId, r]));
  return checks.map((c) => byId.get(c.id)!).filter((r) => r !== undefined);
}

function notApplicable(c: Check): CheckResult {
  return { ...emptyCheck(c, null, 'not_applicable'), applicable: false };
}

function emptyCheck(c: Check, verdict: 'NEED_REVIEW' | null, reason: CheckResult['reason']): CheckResult {
  const r: CheckResult = {
    axisId: c.axisId,
    group: c.group,
    checkId: c.id,
    questionVersion: c.questionVersion,
    applicable: true,
    problem: null,
    needsContext: null,
    verdict,
  };
  if (reason) r.reason = reason;
  return r;
}

async function runLimited<T>(
  limit: number,
  items: readonly T[],
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
}
