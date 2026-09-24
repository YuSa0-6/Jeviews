// Vercel AI Gateway 経由で Jev を呼ぶ。https://vercel.com/ai-gateway/models/jev
// 通信形式は @ai-sdk/gateway の評価モデル (createGateway().evaluationModel) に任せる。
// 価格は Gateway 側の設定に依存し固定でないため usdPerInputToken は null。

import { createGateway } from '@ai-sdk/gateway';
import type { Provider } from '../../review/ports.js';
import { type EvaluationOptions, evaluateNoul } from './evaluate.js';

export interface VercelGatewayOptions extends EvaluationOptions {
  apiKey: string;
  model?: string;
  /** 省略時は SDK の既定 (https://ai-gateway.vercel.sh/v4/ai)。 */
  baseUrl?: string;
}

const DEFAULT_MODEL = 'typesafe-ai/jev';

export function createVercelGatewayProvider(opts: VercelGatewayOptions): Provider {
  const model = opts.model ?? DEFAULT_MODEL;

  return {
    model,
    usdPerInputToken: null,
    ask: (state, questions) =>
      evaluateNoul(
        (fetch) =>
          createGateway({
            apiKey: opts.apiKey,
            fetch,
            ...(opts.baseUrl !== undefined && { baseURL: opts.baseUrl }),
          }).evaluationModel(model),
        state,
        questions,
        opts,
      ),
  };
}
