// 共通のレビュー処理。対象ごとに Jev へ問い合わせ、判定し、公開 JSON を組み立てる。
// 依存は引数で渡す。

import { createHash, randomUUID } from 'node:crypto';
import { CHECKS, type Check, questionId } from './checks.js';
import { fileKind } from './file-kind.js';
import type { CheckResult, FileKind, FileResult, ProviderId, ReviewOutput, Thresholds, Usage } from './output.js';
import { type Exclusion, type Provider, ProviderError, type Question, type StaticAnalysis, type StaticAnalyzer, type StaticCheckResult, type SystemOneResponse, type TrackedFile } from './ports.js';
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
  analyzers?: readonly StaticAnalyzer[];
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
  const usage: Usage = {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
  };
  let usageComplete = true;
  const analyzers = deps.analyzers ?? [];
  const staticAnalysis = await runAnalyzers(analyzers, deps.files, new Set(checks.map((c) => c.id)), log);

  const results: FileResult[] = new Array(deps.files.length);
  await runLimited(deps.concurrency ?? 4, deps.files, async (file, i) => {
    const kind = fileKind(file.path);
    log(`[${i + 1}/${deps.files.length}] ${file.path} (${file.bytes} bytes, ${kind})`);
    results[i] = await reviewFile(file, kind);
  });

  function addTokens(u: SystemOneResponse['usage']): void {
    if (typeof u?.input_tokens === 'number') {
      usage.inputTokens! += u.input_tokens;
      usage.outputTokens! += u.output_tokens ?? 0;
    } else {
      usageComplete = false;
    }
  }

  async function reviewFile(file: TrackedFile, kind: FileKind): Promise<FileResult> {
    const base = {
      path: file.path,
      revision: file.revision,
      bytes: file.bytes,
      kind,
    };
    const applicable = checks.filter((c) => c.appliesTo.includes(kind));
    const skipped = checks.filter((c) => !c.appliesTo.includes(kind)).map((c) => notApplicable(c));
    const withSkipped = (rest: CheckResult[]) => ordered(checks, [...skipped, ...rest]);
    const analyzed = staticAnalysis[file.path] ?? {};
    const resolved = applicable.filter((c) => analyzed[c.id]).map((c) => analyzedCheck(c, analyzed[c.id]!));
    const pending = applicable.filter((c) => !analyzed[c.id]);

    if (applicable.length === 0) {
      return {
        ...base,
        verdict: fileVerdict(skipped),
        checks: ordered(checks, skipped),
      };
    }
    if (pending.length === 0) {
      const cs = withSkipped(resolved);
      return { ...base, verdict: fileVerdict(cs), checks: cs };
    }
    if (file.bytes > maxStateBytes) {
      const cs = withSkipped([...resolved, ...pending.map((c) => emptyCheck(c, 'NEED_REVIEW', 'input_too_large'))]);
      return { ...base, verdict: fileVerdict(cs), checks: cs };
    }

    try {
      const state = { path: file.path, content: file.content };
      const { response, attempts } = await deps.provider.ask(state, buildQuestions(pending));
      usage.requests += attempts;
      addTokens(response.usage);
      const cs = withSkipped([...resolved, ...pending.map((c) => answeredCheck(c, response.answers, thresholds))]);
      const result: FileResult = {
        ...base,
        verdict: fileVerdict(cs),
        checks: cs,
      };
      if (cs.some((c) => c.applicable && c.verdict === null)) {
        result.error = {
          code: 'invalid_response',
          message: 'answer missing for some questions',
        };
      }
      return result;
    } catch (e) {
      const err = e as ProviderError & { attempts?: number };
      usage.requests += err.attempts ?? 1;
      return failedResult(base, withSkipped, pending, err, resolved);
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
      policyHash: policyHash(checks, thresholds, deps.model, analyzers),
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

function buildQuestions(checks: readonly Check[]): Record<string, Question> {
  const q: Record<string, Question> = {};
  for (const c of checks) {
    q[questionId(c.id, 'problem')] = { type: 'noul', instructions: c.problem };
    q[questionId(c.id, 'needsContext')] = {
      type: 'noul',
      instructions: c.needsContext,
    };
  }
  return q;
}

function policyHash(checks: readonly Check[], thresholds: Thresholds, model: string, analyzers: readonly StaticAnalyzer[]): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        checks,
        thresholds,
        model,
        analyzers: analyzers.map((analyzer) => (analyzer.version === undefined ? analyzer.id : `${analyzer.id}@${analyzer.version}`)),
      }),
    )
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

async function runLimited<T>(limit: number, items: readonly T[], fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
}

function answeredCheck(c: Check, answers: SystemOneResponse['answers'], thresholds: Thresholds): CheckResult {
  const p = answers[questionId(c.id, 'problem')]?.noul;
  const n = answers[questionId(c.id, 'needsContext')]?.noul;
  if (p === undefined || n === undefined) return emptyCheck(c, null, 'api_error');
  const v = checkVerdict(p, n, thresholds, c.group);
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
}

function analyzedCheck(c: Check, result: StaticCheckResult): CheckResult {
  const evidence: NonNullable<CheckResult['evidence']> = {
    source: result.source,
  };
  if (result.detail) evidence.detail = result.detail;
  return {
    axisId: c.axisId,
    group: c.group,
    checkId: c.id,
    questionVersion: c.questionVersion,
    applicable: true,
    // probability は Jev が返した noul の値。静的解析の確定判定では合成せず null にする。
    problem: null,
    needsContext: null,
    verdict: result.verdict,
    evidence,
  };
}

async function runAnalyzers(analyzers: readonly StaticAnalyzer[], files: readonly TrackedFile[], knownIds: ReadonlySet<string>, log: (line: string) => void): Promise<StaticAnalysis> {
  const merged: StaticAnalysis = {};
  for (const analyzer of analyzers) {
    try {
      const analysis = await analyzer.analyze(files);
      // 未知の checkId は判定に使われないまま静かに消えるので、analyzer ごとに 1 行で知らせる。
      const unknown = new Set<string>();
      for (const [path, checks] of Object.entries(analysis)) {
        for (const [checkId, result] of Object.entries(checks)) {
          if (!knownIds.has(checkId)) {
            unknown.add(checkId);
            continue;
          }
          // 先に判定した analyzer を優先する。後勝ちで静かに上書きしない。
          const existing = merged[path]?.[checkId];
          if (existing !== undefined) {
            log(`analyzer ${analyzer.id}: ${path}/${checkId} は ${existing.source} の判定を優先します`);
            continue;
          }
          merged[path] = { ...merged[path], [checkId]: result };
        }
      }
      if (unknown.size > 0) log(`analyzer ${analyzer.id}: 未知の checkId を無視します: ${[...unknown].sort().join(', ')}`);
    } catch (error) {
      log(`analyzer ${analyzer.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return merged;
}

function failedResult(base: Omit<FileResult, 'verdict' | 'checks'>, withSkipped: (rest: CheckResult[]) => CheckResult[], applicable: readonly Check[], err: Error, resolved: readonly CheckResult[] = []): FileResult {
  if (err instanceof ProviderError && err.code === 'bad_request') {
    const cs = withSkipped([...resolved, ...applicable.map((c) => emptyCheck(c, 'NEED_REVIEW', 'input_too_large'))]);
    return {
      ...base,
      verdict: fileVerdict(cs),
      checks: cs,
      error: { code: err.code, message: err.message },
    };
  }
  const cs = withSkipped([...resolved, ...applicable.map((c) => emptyCheck(c, null, 'api_error'))]);
  return {
    ...base,
    verdict: fileVerdict(cs),
    checks: cs,
    error: {
      code: err instanceof ProviderError ? err.code : 'unknown',
      message: err.message ?? String(err),
    },
  };
}
