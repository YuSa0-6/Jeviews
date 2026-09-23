// 確率から判定を導く純粋関数。平均しない。対象外を GOOD に数えない。

import type { CheckGroup } from './checks.js';
import type { SourceLanguage } from './file-kind.js';
import type { CheckResult, FileResult, ReasonCode, Thresholds, Verdict } from './output.js';

export const DEFAULT_THRESHOLDS: Thresholds = {
  problemHigh: 0.65,
  // 2026-09-22: 下の high のうち secret_hardcoded (0.72) 以外の 6 件は problemLow (0.35) を下回る。
  // checkVerdict は上から順に見るため、high < problemLow の観点では high 未満の problem が
  // 必ず problemLow も下回り、uncertain の NEED_REVIEW が出なくなる (NG か GOOD の二択になる)。
  // 値自体は評価に基づく意図。帯を戻すなら problemLowByCheck の新設が要る (今後の検討事項)。
  problemHighByCheck: {
    error_empty_catch: 0.06,
    error_success_after_failure: 0.08,
    error_unhandled_promise: 0.09,
    input_missing_unhandled: 0.15,
    input_unchecked_use: 0.14,
    secret_hardcoded: 0.72,
    secret_logged: 0.06,
  },
  problemHighByLanguageAndCheck: {
    'ruby:complexity_branchy_function': 0.26,
  },
  problemHighByGroup: { lint: 0.8, complexity: 0.6 },
  problemLow: 0.35,
  needsContextHigh: 0.65,
};

export function checkVerdict(
  problem: number,
  needsContext: number,
  t: Thresholds,
  group?: CheckGroup,
  checkId?: string,
  language?: SourceLanguage,
): { verdict: Verdict; reason?: ReasonCode } {
  const languageCheck = language === undefined || checkId === undefined ? undefined : `${language}:${checkId}`;
  const high =
    (languageCheck === undefined ? undefined : t.problemHighByLanguageAndCheck[languageCheck]) ??
    (checkId === undefined ? undefined : t.problemHighByCheck[checkId]) ??
    (group === undefined ? undefined : t.problemHighByGroup[group]) ??
    t.problemHigh;
  if (problem >= high) return { verdict: 'NG' };
  if (needsContext >= t.needsContextHigh) return { verdict: 'NEED_REVIEW', reason: 'needs_context' };
  if (problem > t.problemLow) return { verdict: 'NEED_REVIEW', reason: 'uncertain' };
  return { verdict: 'GOOD' };
}

/** ファイル判定へ上げる NEED_REVIEW の理由。uncertain は観点の結果にだけ残す。 */
const ESCALATING_REASONS: ReadonlySet<ReasonCode> = new Set(['needs_context', 'input_too_large']);

/**
 * ファイルの判定は適用した観点の判定から機械的に集約する。
 * NG が一つでもあれば NG。
 * needs_context か input_too_large の NEED_REVIEW が一つでもあれば NEED_REVIEW。
 * 判定できなかった観点 (api_error) が残れば判定しない。
 * それ以外は GOOD。uncertain の観点は GOOD の側に数える。確率は JSON に残る。
 * 適用した観点が 0 なら判定しない。
 */
export function fileVerdict(checks: readonly CheckResult[]): Verdict | null {
  const applied = checks.filter((c) => c.applicable);
  if (applied.length === 0) return null;
  if (applied.some((c) => c.verdict === 'NG')) return 'NG';
  if (applied.some((c) => c.verdict === 'NEED_REVIEW' && c.reason !== undefined && ESCALATING_REASONS.has(c.reason))) {
    return 'NEED_REVIEW';
  }
  if (applied.some((c) => c.verdict === null)) return null;
  return 'GOOD';
}

export function runStatus(files: readonly FileResult[]): 'completed' | 'partial' {
  return files.some((f) => f.error !== undefined) ? 'partial' : 'completed';
}
