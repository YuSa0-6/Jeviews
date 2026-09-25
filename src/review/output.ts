// 公開 JSON の型。実行途中の State とは別に保つ。

export type Verdict = 'GOOD' | 'NG' | 'NEED_REVIEW';
export type AxisId = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';
export type Scope = 'all' | 'diff';
export type Mode = 'scan';
export type RunStatus = 'completed' | 'partial' | 'failed';

/** 判定に至らなかった、または NEED_REVIEW になった理由。 */
export type ReasonCode =
  | 'not_applicable' // このファイル種別には適用しない。質問を送っていない
  | 'input_too_large' // state が上限を超えたので Jev に送っていない
  | 'needs_context' // Jev が材料不足と判断した
  | 'uncertain' // problem の確率が閾値の間にある。観点の結果に残すがファイル判定には上げない
  | 'api_error'; // Jev の呼び出しに失敗した

export type FileKind = 'code' | 'test' | 'config' | 'template' | 'doc' | 'other';

export interface Thresholds {
  /** これ以上なら NG */
  problemHigh: number;
  /** 確認項目ごとの problemHigh の上書き。group より優先する */
  problemHighByCheck: Record<string, number>;
  /** 言語と確認項目の組み合わせによる上書き。check 単位より優先する */
  problemHighByLanguageAndCheck: Record<string, number>;
  /** 観点グループごとの problemHigh の上書き。書かれていないグループは problemHigh を使う */
  problemHighByGroup: Record<string, number>;
  /** これ未満なら問題なし。problemHigh との間は NEED_REVIEW */
  problemLow: number;
  /** needsContext がこれ以上なら NEED_REVIEW */
  needsContextHigh: number;
}

export interface CheckResult {
  axisId: AxisId;
  /** 観点。複数の原子的な確認項目をまとめる単位 */
  group: string;
  checkId: string;
  questionVersion: string;
  /** false なら質問を送っておらず、GOOD にも数えない */
  applicable: boolean;
  problem: { probability: number } | null;
  needsContext: { probability: number } | null;
  verdict: Verdict | null;
  reason?: ReasonCode;
  evidence?: { source: string; detail?: string };
}

export interface FileResult {
  path: string;
  /** 実際に読んだ内容の sha256 */
  revision: string;
  bytes: number;
  /** 拡張子とファイル名から決めた種別。適用条件の根拠 */
  kind: FileKind;
  verdict: Verdict | null;
  checks: CheckResult[];
  error?: { code: string; message: string };
}

export interface Usage {
  /** HTTP 再試行を含む送信回数 */
  requests: number;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}

export type ProviderId = 'typesafe' | 'vercel-gateway' | 'openrouter';

/** diff --base で比べた起点。指定した参照と、HEAD がそこから分かれたコミット */
export interface DiffBase {
  ref: string;
  mergeBase: string;
}

export interface ReviewOutput {
  schemaVersion: 1;
  run: {
    id: string;
    /** 対象。failed で対象が決まる前に終わった場合だけ null */
    scope: Scope | null;
    /** diff --base で比べた起点。それ以外は null */
    base: DiffBase | null;
    mode: Mode;
    /** 接続先。failed で接続先が決まる前に終わった場合だけ null */
    provider: ProviderId | null;
    model: string;
    snapshotId: string;
    policyHash: string;
    thresholds: Thresholds;
    maxStateBytes: number;
    status: RunStatus;
    startedAt: string;
    finishedAt: string;
    usage: Usage;
    fatalError?: { code: string; message: string };
  };
  files: FileResult[];
  exclusions: Array<{ path: string; reason: string }>;
}
