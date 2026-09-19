// 判断基準のデータ。哲学 ID、観点 (group)、確認項目 ID、Jev への質問、質問の版を持つ。
// 質問文は仮説であり、評価を通して書き換える。
//
// Jev は各質問を独立に評価し、質問 ID も他の質問も見ない
// (https://docs.typesafe.ai/primitives.md 、 https://docs.typesafe.ai/api.md)。
// そのため needsContext の質問には、対応する problem の質問文をそのまま埋め込む。
//
// 2026-09-19.3: 一文に複数の判断を束ねた質問を原子的な yes/no に分割した。
// jaggedness ページの "Hiding several judgments inside one question" を避けるため。

import type { FileKind } from './file-kind.js';
import type { AxisId } from './output.js';

/** 観点。設計文書の初版 5 観点。 */
export type CheckGroup = 'input_validation' | 'error_handling' | 'secret_exposure' | 'formatting' | 'lint';

/**
 * 観点ごとの適用条件。2026-09-19 の初回実行で、否定形の問いがコードでないファイルに
 * 「はい」に寄ることがわかったため、ファイル種別で観点を外す。
 */
export const GROUP_APPLIES_TO: Record<CheckGroup, readonly FileKind[]> = {
  input_validation: ['code'],
  error_handling: ['code'],
  lint: ['code'],
  formatting: ['code', 'config'],
  secret_exposure: ['code', 'config', 'doc', 'other'],
};

export interface Check {
  id: string;
  group: CheckGroup;
  axisId: AxisId;
  /** このファイル種別にだけ質問を送る */
  appliesTo: readonly FileKind[];
  questionVersion: string;
  /** 「問題があるか」を問う noul。state の `content` を参照する。 */
  problem: string;
  /** 「この判断に他のファイルが必要か」を問う noul。problem の文を含む。 */
  needsContext: string;
}

interface CheckSeed {
  id: string;
  group: CheckGroup;
  axisId: AxisId;
  problem: string;
}

const QUESTION_VERSION = '2026-09-19.6';

const SEEDS: readonly CheckSeed[] = [
  // 入力の検証漏れ
  {
    id: 'input_unchecked_use',
    group: 'input_validation',
    axisId: 'A',
    // 2026-09-19.5: "outside the file" では内部の引数も含まれ、純粋なモジュールが NG になった。
    // 2026-09-19.6: 出所の列挙では file.content を扱うだけのモジュールも NG になった。
    // 「このファイル自身が直接読む」に絞り、I/O を行うファイルが検査の責任を負う意味にする。
    problem:
      'Does `content` itself directly read a value from outside the program (for example by calling process.argv, process.env, fetch, a request handler, readFile, or stdin) and then use that value before checking its format or range?',
  },
  {
    id: 'input_missing_unhandled',
    group: 'input_validation',
    axisId: 'A',
    // 2026-09-19.5: 「怠っているか」の否定形は処理が無いだけで「はい」に寄った。具体的な失敗の形で問う。
    problem:
      'When `content` reads a value from outside the program (command-line arguments, environment variables, network responses, or file contents) and that value is absent or empty, does the code proceed as if the value were present?',
  },
  // エラーの握りつぶし
  {
    id: 'error_empty_catch',
    group: 'error_handling',
    axisId: 'C',
    problem:
      'Does `content` contain a catch block or error handler that discards the error without logging it, rethrowing it, or returning a failure?',
  },
  {
    id: 'error_success_after_failure',
    group: 'error_handling',
    axisId: 'C',
    problem:
      'Does `content` return a success value or continue as if the operation succeeded after that operation has failed?',
  },
  {
    id: 'error_unhandled_promise',
    group: 'error_handling',
    axisId: 'C',
    problem:
      'Does `content` start an asynchronous operation (a promise) whose rejection is never awaited or handled?',
  },
  // 秘密情報の露出
  {
    id: 'secret_hardcoded',
    group: 'secret_exposure',
    axisId: 'B',
    problem:
      'Does `content` contain a hard-coded credential value, such as an API key, password, access token, or private key?',
  },
  {
    id: 'secret_logged',
    group: 'secret_exposure',
    axisId: 'B',
    problem:
      'Does `content` write a credential value (API key, password, or token) to logs, standard output, standard error, or an error message?',
  },
  // フォーマット
  {
    id: 'format_indentation',
    group: 'formatting',
    axisId: 'E',
    problem: 'Does `content` mix indentation styles, such as tabs and spaces or different indent widths, within the file?',
  },
  {
    id: 'format_quotes',
    group: 'formatting',
    axisId: 'E',
    problem: 'Does `content` mix single and double quotes for string literals without a consistent rule?',
  },
  {
    id: 'format_spacing',
    group: 'formatting',
    axisId: 'E',
    problem: 'Does `content` have inconsistent spacing around operators, commas, or braces within the file?',
  },
  // Lint 相当
  {
    id: 'lint_unused',
    group: 'lint',
    axisId: 'E',
    problem: 'Does `content` declare a variable, parameter, or import that is never used?',
  },
  {
    id: 'lint_unreachable',
    group: 'lint',
    axisId: 'E',
    problem: 'Does `content` contain code that can never execute, for example statements after a return or throw?',
  },
  {
    id: 'lint_duplicate_condition',
    group: 'lint',
    axisId: 'E',
    problem: 'Does `content` repeat the same condition in an if/else chain or switch so that a later branch can never be reached?',
  },
  {
    id: 'lint_constant_condition',
    group: 'lint',
    axisId: 'E',
    problem: 'Does `content` contain a comparison or condition that is always true or always false?',
  },
];

export function needsContextFor(problem: string): string {
  return (
    `Consider this yes/no judgment about \`content\`: "${problem}" ` +
    'To make that judgment with reasonable certainty, would you need to see other files in the same repository ' +
    '(callers, tests, configuration, or documentation) that are not included in `content`?'
  );
}

export const CHECKS: readonly Check[] = SEEDS.map((s) => ({
  id: s.id,
  group: s.group,
  axisId: s.axisId,
  appliesTo: GROUP_APPLIES_TO[s.group],
  questionVersion: QUESTION_VERSION,
  problem: s.problem,
  needsContext: needsContextFor(s.problem),
}));

/** Jev の questions マップで使う質問 ID。checkId と問いの種類から決定的に作る。 */
export function questionId(checkId: string, kind: 'problem' | 'needsContext'): string {
  return `${checkId}__${kind}`;
}
