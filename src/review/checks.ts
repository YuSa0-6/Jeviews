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
export type CheckGroup =
  | 'input_validation'
  | 'error_handling'
  | 'secret_exposure'
  | 'formatting'
  | 'lint'
  | 'complexity';

/**
 * 観点ごとの適用条件。2026-09-19 の初回実行で、否定形の問いがコードでないファイルに
 * 「はい」に寄ることがわかったため、ファイル種別で観点を外す。
 */
const GROUP_APPLIES_TO: Record<CheckGroup, readonly FileKind[]> = {
  input_validation: ['code'],
  error_handling: ['code'],
  lint: ['code'],
  complexity: ['code'],
  formatting: ['code', 'test', 'config', 'template'],
  secret_exposure: ['code', 'test', 'config', 'doc', 'other'],
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

type CheckSeed = Pick<Check, 'id' | 'group' | 'axisId' | 'problem'>;

const QUESTION_VERSION = '2026-09-22.11';

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
      'Does `content` take a non-empty value read from outside the program (command-line arguments, environment variables, network responses, or file contents) and use it as a number, a URL, a file path, or a member of a fixed set of options, without first checking that it has that form? A missing or empty value alone does not count for this question. A value that is only passed through as an opaque string, such as an API key or a model name, does not count.',
  },
  {
    id: 'input_missing_unhandled',
    group: 'input_validation',
    axisId: 'A',
    // 2026-09-19.5: 「怠っているか」の否定形は処理が無いだけで「はい」に寄った。具体的な失敗の形で問う。
    problem:
      'Does `content` read a value from outside the program (command-line arguments, environment variables, network responses, or file contents) and, when the value is absent or empty, continue to use that missing value as though it were present in an operation performed by this file? Merely returning or passing an opaque value to another layer does not count. Explicitly substituting a default, returning a failure, or raising an error counts as handling absence and does not count.',
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
      'Does `content` start an asynchronous operation (a promise, future, or async task) whose failure is never awaited or handled? Enqueuing a background job through a job queue (for example perform_async, perform_later, or enqueue) does not count.',
  },
  // 秘密情報の露出
  {
    id: 'secret_hardcoded',
    group: 'secret_exposure',
    axisId: 'B',
    problem:
      'Does `content` contain a hard-coded credential value, such as an API key, password, access token, or private key? An empty value, a placeholder such as "changeme", "xxx", or "<your key>", or a variable name with no value after it does not count.',
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
    problem:
      'Does `content` mix indentation styles, such as tabs and spaces or different indent widths, within the file?',
  },
  {
    id: 'format_quotes',
    group: 'formatting',
    axisId: 'E',
    problem:
      'Does `content` mix single and double quotes for string literals without a consistent rule? Using double quotes only where interpolation or escape sequences are needed, and single quotes elsewhere, is a consistent rule.',
  },
  {
    id: 'format_spacing',
    group: 'formatting',
    axisId: 'E',
    problem: 'Does `content` have inconsistent spacing around operators, commas, or braces within the file?',
  },
  // Lint 相当
  {
    id: 'lint_unused_import',
    group: 'lint',
    axisId: 'E',
    problem:
      'Is there an import, require, or use statement in `content` that brings in a name which is never referenced anywhere else in `content`? A require or import whose purpose is to load a library or plugin for its side effects (for example require "rails" or a railtie) does not count.',
  },
  {
    id: 'lint_unused_variable',
    group: 'lint',
    axisId: 'E',
    problem:
      'Is there a specific local variable binding declared in `content` whose name has no read reference after that declaration within its lexical scope? Answer yes only if you can identify the exact binding and check the whole scope. A reference in a nested closure, JSX expression, template, shorthand property, computed property, decorator, or type expression counts as a read. Do not count imports, parameters, object or class fields, assignment to an existing nonlocal name, or names starting with an underscore. If any possible reference or scope boundary is unclear, answer no.',
  },
  {
    id: 'lint_unused_param',
    group: 'lint',
    axisId: 'E',
    problem:
      'Is there a specific parameter of a function, method, lambda, or callback in `content` whose name has no reference anywhere in that function body? Answer yes only if you can identify the exact parameter name and inspect the complete corresponding body; otherwise answer no. A reference in a nested closure, JSX expression, template, shorthand property, decorator, type expression, or forwarding call such as super counts as a reference. A parameter kept only for callback, hook, override, or public API compatibility is still unused. Do not count a declaration or overload signature without a body, a receiver or this parameter, a Python double-underscore method parameter, or a name starting with an underscore.',
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
    problem:
      'Does `content` repeat the same condition in an if/else chain or switch so that a later branch can never be reached?',
  },
  {
    id: 'complexity_branchy_function',
    group: 'complexity',
    axisId: 'E',
    problem:
      'Does `content` contain a single function or method with at least 15 branch points? Count each if, else if, loop, case, catch, ternary, and && or || operator in that one body, including JSX expressions. Answer from the count rather than the function length or an overall impression.',
  },
  {
    id: 'lint_constant_condition',
    group: 'lint',
    axisId: 'E',
    problem:
      'Does `content` contain an if, unless, while, or ternary condition, or a comparison, that is always true or always false? A method or function that simply returns a literal true or false is not a condition and does not count.',
  },
];

function needsContextFor(problem: string): string {
  return (
    `Consider this yes/no judgment about \`content\`: "${problem}" ` +
    'To make that judgment with reasonable certainty, would you need to see other files in the same repository ' +
    '(callers, tests, configuration, or documentation) that are not included in `content`? ' +
    'If `content` contains no code that performs the operation the judgment is about, the answer is no.'
  );
}

export const CHECKS: readonly Check[] = SEEDS.map((s) => ({
  ...s,
  appliesTo: GROUP_APPLIES_TO[s.group],
  questionVersion: QUESTION_VERSION,
  needsContext: needsContextFor(s.problem),
}));

/** Jev の questions マップで使う質問 ID。checkId と問いの種類から決定的に作る。 */
export function questionId(checkId: string, kind: 'problem' | 'needsContext'): string {
  return `${checkId}__${kind}`;
}
