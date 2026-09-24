// TypeSafe 直結。@ai-sdk/typesafe-ai の評価モデル (POST {baseUrl}/v1/systemone) を使う。
// 出典: https://ai-sdk.dev/providers/ai-sdk-providers/typesafe-ai 、 https://docs.typesafe.ai/models.md

import { createTypeSafeAi } from '@ai-sdk/typesafe-ai';
import type { Provider } from '../../review/ports.js';
import { type EvaluationOptions, evaluateNoul } from './evaluate.js';

export interface TypeSafeOptions extends EvaluationOptions {
  apiKey: string;
  model?: string;
  /** API のホスト。SDK の baseURL はこれに /v1 を付けたもの。 */
  baseUrl?: string;
}

const DEFAULT_MODEL = 'jev-latest';
const DEFAULT_BASE_URL = 'https://api.typesafe.ai';
/** 出典: https://docs.typesafe.ai/models.md の価格。入力トークンのみ課金。 */
const USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;

export function createTypeSafeProvider(opts: TypeSafeOptions): Provider {
  const model = opts.model ?? DEFAULT_MODEL;
  const baseURL = `${(opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '')}/v1`;

  return {
    model,
    usdPerInputToken: USD_PER_INPUT_TOKEN,
    ask: (state, questions) =>
      evaluateNoul(
        (fetch) => createTypeSafeAi({ apiKey: opts.apiKey, baseURL, fetch }).evaluationModel(model),
        state,
        questions,
        opts,
      ),
  };
}
