// AI SDK の experimental_evaluate で評価モデルを呼ぶ共通部分。
// 通信形式・再試行 (429/5xx/通信エラー。Retry-After は 60 秒未満のときだけ尊重し、それ以上は 2s/4s の指数待機) は SDK に任せ、ここでは
//   - 呼び出しごとの HTTP リクエスト数を数える (usage.requests 用。SDK の結果には含まれない)
//   - SDK の回答を review 側の noul 形式に読み替える
//   - SDK の例外を ProviderError に分類する
// だけを行う。

import { GatewayError } from '@ai-sdk/gateway';
import { APICallError, type Experimental_EvaluationModel, experimental_evaluate, RetryError } from 'ai';
import {
  type NoulAnswer,
  ProviderError,
  type ProviderErrorCode,
  type ProviderResult,
  type Question,
  type SystemOneResponse,
} from '../../review/ports.js';

export interface EvaluationOptions {
  /** テスト用。既定はグローバル fetch。 */
  fetch?: typeof fetch;
  /** 初回を除く再試行回数。既定は SDK と同じ 2。 */
  maxRetries?: number;
}

/**
 * `createModel` には呼び出しごとの計数付き fetch が渡る。並行する ask の間でカウンタを共有しないため、
 * モデルは呼び出しのたびに作る (プロバイダ生成は設定オブジェクトを作るだけで軽い)。
 */
export async function evaluateNoul(
  createModel: (fetch: typeof globalThis.fetch) => Experimental_EvaluationModel,
  state: unknown,
  questions: Record<string, Question>,
  opts: EvaluationOptions,
): Promise<ProviderResult> {
  const inner = opts.fetch ?? fetch;
  let attempts = 0;
  const countingFetch: typeof fetch = (input, init) => {
    attempts += 1;
    return inner(input, init);
  };

  const sdkQuestions: Record<string, { type: 'boolean'; instructions: string }> = {};
  for (const [id, q] of Object.entries(questions)) sdkQuestions[id] = { type: 'boolean', instructions: q.instructions };

  const result = await experimental_evaluate({
    model: createModel(countingFetch),
    state: state as Parameters<typeof experimental_evaluate>[0]['state'],
    questions: sdkQuestions,
    ...(opts.maxRetries !== undefined && { maxRetries: opts.maxRetries }),
  }).catch((e: unknown) => {
    const err = toProviderError(e);
    err.attempts = Math.max(attempts, 1);
    throw err;
  });

  const answers: Record<string, NoulAnswer> = {};
  for (const [id, a] of Object.entries(result.answers)) answers[id] = { type: 'noul', noul: a.probability };
  const response: SystemOneResponse = { model: result.response.modelId, answers };
  const { inputTokens, outputTokens } = result.usage;
  if (inputTokens !== undefined || outputTokens !== undefined) {
    response.usage = {};
    if (inputTokens !== undefined) response.usage.input_tokens = inputTokens;
    if (outputTokens !== undefined) response.usage.output_tokens = outputTokens;
  }
  return { response, attempts };
}

function toProviderError(e: unknown): ProviderError {
  const cause = innermostCause(e);
  const message = cause instanceof Error ? cause.message : String(cause);
  const status = APICallError.isInstance(cause) || GatewayError.isInstance(cause) ? cause.statusCode : undefined;
  if (status !== undefined) return new ProviderError(codeForStatus(status), `HTTP ${status}: ${message}`, status);
  // HTTP 応答なし。SDK が本文の解析・検証に失敗した例外なら応答の形が不正、それ以外は通信の失敗。
  const shapeError =
    cause instanceof Error && /^AI_(InvalidResponseData|JSONParse|TypeValidation)Error$/.test(cause.name);
  return new ProviderError(shapeError ? 'invalid_response' : 'network', message);
}

/**
 * 再試行の最後の失敗を取り出す。Gateway は失敗をすべて GatewayError に包み、HTTP 応答がないとき
 * (通信失敗・タイムアウト) も statusCode=500 等を付けるため、内側の cause があればそちらで判定する。
 */
function innermostCause(e: unknown): unknown {
  const last = RetryError.isInstance(e) ? e.lastError : e;
  return GatewayError.isInstance(last) && last.cause !== undefined ? last.cause : last;
}

function codeForStatus(status: number): ProviderErrorCode {
  if (status === 401 || status === 403) return 'auth';
  if (status === 400 || status === 404 || status === 422) return 'bad_request';
  if (status === 429) return 'rate_limit';
  return status < 300 ? 'invalid_response' : 'server';
}
