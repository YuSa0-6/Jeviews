// 共通のレビュー処理。対象ごとに Jev へ問い合わせ、判定し、公開 JSON を組み立てる。
// 依存は引数で渡す。

import { createHash, randomUUID } from 'node:crypto';
import { CHECKS, type Check, questionId } from './checks.js';
import { fileKind, type SourceLanguage, sourceLanguage } from './file-kind.js';
import type { AxisId, CheckResult, FileKind, FileResult, ProviderId, ReviewOutput, Thresholds, Usage } from './output.js';
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

/** 失敗した判断軸と、そのときのエラー。 */
interface AxisFailure {
  axisId: AxisId;
  error: Error;
}

/** 軸ごとの問い合わせ結果。失敗した軸があっても成功した軸の回答は残す。 */
interface AxisAnswers {
  answers: SystemOneResponse['answers'];
  failures: AxisFailure[];
  /** 問い合わせた軸の数。全軸が失敗したかの判定に使う。 */
  axes: number;
}

/** 失敗するまでに送った HTTP リクエスト数。報告が無ければ 1 回とみなす。 */
function attemptsOf(error: Error): number {
  return (error as ProviderError & { attempts?: number }).attempts ?? 1;
}

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

  async function ask(state: unknown, requestedChecks: readonly Check[]): Promise<SystemOneResponse['answers']> {
    const { response, attempts } = await deps.provider.ask(state, buildQuestions(requestedChecks));
    usage.requests += attempts;
    addTokens(response.usage);
    return response.answers;
  }

  // 判断軸ごとに質問を分けるので、1 ファイルあたりのリクエスト数は軸の数だけ増える。
  // 軸は逐次に問い合わせる。並列にすると同時リクエスト数が concurrency x 軸数になり、rate limit の設計判断が要るため。
  async function askByAxis(state: unknown, requestedChecks: readonly Check[]): Promise<AxisAnswers> {
    const grouped = new Map<AxisId, Check[]>();
    for (const check of requestedChecks) {
      const checksForAxis = grouped.get(check.axisId) ?? [];
      checksForAxis.push(check);
      grouped.set(check.axisId, checksForAxis);
    }
    const answers: SystemOneResponse['answers'] = {};
    const failures: AxisFailure[] = [];
    // 1 軸の失敗で成功した軸の回答まで捨てないよう、軸ごとに失敗を隔離する。
    for (const [axisId, checksForAxis] of grouped) {
      try {
        Object.assign(answers, await ask(state, checksForAxis));
      } catch (e) {
        failures.push({ axisId, error: e as Error });
      }
    }
    return { answers, failures, axes: grouped.size };
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
    const language = sourceLanguage(file.path);
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
      const { answers, failures, axes } = await askByAxis(state, pending);
      if (failures.length === axes) {
        // 全軸が失敗したときは従来どおり最初のエラーを投げ、catch と failedResult に任せる。
        // 先頭のエラーの attempts は catch が数えるので、ここでは残りの軸の分だけ数える。
        for (const f of failures.slice(1)) usage.requests += attemptsOf(f.error);
        throw failures[0]!.error;
      }
      // 一部の軸だけ失敗した場合。失敗した軸の分もリクエスト数には数える。
      for (const f of failures) usage.requests += attemptsOf(f.error);
      const cs = withSkipped([...resolved, ...pending.map((c) => answeredCheck(c, answers, thresholds, language))]);
      const result: FileResult = {
        ...base,
        verdict: fileVerdict(cs),
        checks: cs,
      };
      if (failures.length > 0) {
        // 回答が無い観点は answeredCheck が api_error にしている。部分失敗を JSON から読めるよう error を立てる。
        const first = failures[0]!.error;
        result.error = {
          code: first instanceof ProviderError ? first.code : 'unknown',
          message: `axis ${failures.map((f) => f.axisId).join(', ')}: ${first.message ?? String(first)}`,
        };
      } else if (cs.some((c) => c.applicable && c.verdict === null)) {
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

function answeredCheck(
  c: Check,
  answers: SystemOneResponse['answers'],
  thresholds: Thresholds,
  language?: SourceLanguage,
): CheckResult {
  const p = answers[questionId(c.id, 'problem')]?.noul;
  const n = answers[questionId(c.id, 'needsContext')]?.noul;
  if (p === undefined || n === undefined) return emptyCheck(c, null, 'api_error');
  const v = checkVerdict(p, n, thresholds, c.group, c.id, language);
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
