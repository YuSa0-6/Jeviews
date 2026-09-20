// review が外側に求める契約 (port)。実装は src/adapters/ に置き、ここへ合わせる。
// review はこのファイルの型だけを見る。adapters から review への import はこの向きだけ。

// ---- Provider: Jev へ state と questions を送り、質問ごとの確率を受け取る ----

export interface NoulQuestion {
  type: 'noul';
  instructions: string;
}

export type Question = NoulQuestion;

export interface NoulAnswer {
  type: 'noul';
  noul: number;
}

export interface SystemOneResponse {
  model: string;
  answers: Record<string, NoulAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export interface ProviderResult {
  response: SystemOneResponse;
  /** この呼び出しで送った HTTP リクエスト数。再試行を含む。 */
  attempts: number;
}

export interface Provider {
  /** 接続先に渡すモデル名。公開 JSON の run.model にそのまま出る。 */
  model: string;
  /** 入力 1 トークンあたりの USD。価格が公開されていなければ null。 */
  usdPerInputToken: number | null;
  ask(state: unknown, questions: Record<string, Question>): Promise<ProviderResult>;
}

export type ProviderErrorCode = 'auth' | 'bad_request' | 'rate_limit' | 'server' | 'network' | 'invalid_response';

export class ProviderError extends Error {
  /** 失敗するまでに送った HTTP リクエスト数。usage.requests の集計に使う。 */
  attempts?: number;

  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

// ---- Repository: レビュー対象のファイルを取り出す ----

export interface TrackedFile {
  path: string;
  content: string;
  bytes: number;
  /** 実際に読んだ内容の sha256 */
  revision: string;
}

export interface Exclusion {
  path: string;
  reason: string;
}

export interface Repository {
  /** 対象全体を識別する ID。Git なら HEAD のコミット */
  snapshotId(): Promise<string>;
  listAll(): Promise<{ files: TrackedFile[]; exclusions: Exclusion[] }>;
}
