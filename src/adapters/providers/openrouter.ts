// OpenRouter 経由で Jev を呼ぶ。https://openrouter.ai/typesafe/jev-1.13
// 通信形式は @openrouter/ai-sdk-provider の評価モデル (POST {decisionsBaseURL}/decisions、alpha 版 API) に任せる。
// SDK は baseURL 末尾の /v1 を /alpha に置き換えて Decisions API の URL を作る。

import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { Provider } from '../../review/ports.js';
import { type EvaluationOptions, evaluateNoul } from './evaluate.js';

export interface OpenRouterOptions extends EvaluationOptions {
  apiKey: string;
  model?: string;
  /** OpenRouter API のベース URL。末尾は /v1。省略時は SDK の既定 (https://openrouter.ai/api/v1)。 */
  baseUrl?: string;
}

/** 常に最新の Jev を指す別名。TypeSafe 直結の既定 jev-latest にそろえる。 */
const DEFAULT_MODEL = '~typesafe/jev-latest';
/** 出典: https://openrouter.ai/~typesafe/jev-latest の価格。入力トークンのみ課金。 */
const USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;

export function createOpenRouterProvider(opts: OpenRouterOptions): Provider {
  const model = opts.model ?? DEFAULT_MODEL;
  const baseURL = opts.baseUrl?.replace(/\/$/, '');
  // SDK は /v1 で終わらない baseURL だと評価モデルを作る時点で例外を投げる。ask の前に設定エラーとして止める。
  if (baseURL !== undefined && !baseURL.endsWith('/v1')) {
    throw new Error(`OPENROUTER_BASE_URL must end in /v1: "${opts.baseUrl}"`);
  }

  return {
    model,
    usdPerInputToken: USD_PER_INPUT_TOKEN,
    ask: (state, questions) =>
      evaluateNoul(
        (fetch) =>
          createOpenRouter({
            apiKey: opts.apiKey,
            fetch,
            ...(baseURL !== undefined && { baseURL }),
          }).evaluationModel(model),
        state,
        questions,
        opts,
      ),
  };
}
