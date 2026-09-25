// Cloudflare の REST API 経由で Jev を呼ぶ。https://developers.cloudflare.com/ai/models/typesafe/jev/
// Jev の評価モデルを持つ Cloudflare 向け SDK がないため、POST {baseUrl}/accounts/{accountId}/ai/run をここで評価モデルに包む。
// 本文は TypeSafe 直結と同じ形を { model, input } に入れて送る。応答は Cloudflare API 共通の { result } の中にある。
// 通信・再試行・エラーの形は @ai-sdk/provider-utils に任せ、ほかの接続先と同じ evaluateNoul に載せる。

import {
  combineHeaders,
  createJsonErrorResponseHandler,
  createJsonResponseHandler,
  postJsonToApi,
} from '@ai-sdk/provider-utils';
import type { Experimental_EvaluationModel } from 'ai';
import * as z from 'zod';
import type { Provider } from '../../review/ports.js';
import { type EvaluationOptions, evaluateNoul } from './evaluate.js';

export interface CloudflareOptions extends EvaluationOptions {
  apiKey: string;
  /** URL に入る Cloudflare のアカウント ID。 */
  accountId: string;
  model?: string;
  /** API のルート。省略時は https://api.cloudflare.com/client/v4 。 */
  baseUrl?: string;
}

const DEFAULT_MODEL = 'typesafe/jev';
const DEFAULT_BASE_URL = 'https://api.cloudflare.com/client/v4';
/**
 * 出典: https://developers.cloudflare.com/ai-gateway/features/unified-billing/ 。提供元 (TypeSafe) の単価をそのまま通す。
 * 入力トークンのみ課金。クレジット購入時の 5% 手数料は含めない。
 */
const USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;

const runResponseSchema = z.object({
  result: z.object({
    model: z.string().nullish(),
    answers: z.record(z.string(), z.object({ type: z.literal('noul'), noul: z.number() })),
    usage: z.object({ input_tokens: z.number().nullish(), output_tokens: z.number().nullish() }).nullish(),
  }),
});

const failedResponseHandler = createJsonErrorResponseHandler({
  errorSchema: z.object({
    errors: z.array(z.object({ code: z.number().nullish(), message: z.string() })).min(1),
  }),
  errorToMessage: ({ errors }) =>
    errors.map((e) => (e.code == null ? e.message : `${e.message} (code ${e.code})`)).join('; '),
});

export function createCloudflareProvider(opts: CloudflareOptions): Provider {
  const model = opts.model ?? DEFAULT_MODEL;
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const url = `${baseUrl}/accounts/${encodeURIComponent(opts.accountId)}/ai/run`;

  return {
    model,
    usdPerInputToken: USD_PER_INPUT_TOKEN,
    ask: (state, questions) =>
      evaluateNoul((fetch) => runModel({ url, apiKey: opts.apiKey, model, fetch }), state, questions, opts),
  };
}

function runModel(config: {
  url: string;
  apiKey: string;
  model: string;
  fetch: typeof globalThis.fetch;
}): Experimental_EvaluationModel {
  return {
    specificationVersion: 'v4',
    provider: 'cloudflare.evaluation',
    modelId: config.model,
    supportedQuestionTypes: ['boolean'],
    async doEvaluate({ state, questions, headers, abortSignal }) {
      const { value, rawValue, responseHeaders } = await postJsonToApi({
        url: config.url,
        headers: combineHeaders(
          // AI Gateway のログは既定で本文まで保存する。送ったファイルの中身を残さないよう、本文の保存だけ止める。
          { Authorization: `Bearer ${config.apiKey}`, 'cf-aig-collect-log-payload': 'false' },
          headers,
        ),
        body: {
          model: config.model,
          input: {
            state,
            questions: Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, { ...q, type: 'noul' }])),
          },
        },
        failedResponseHandler,
        successfulResponseHandler: createJsonResponseHandler(runResponseSchema),
        fetch: config.fetch,
        ...(abortSignal !== undefined && { abortSignal }),
      });

      const { model, answers, usage } = value.result;
      return {
        answers: Object.fromEntries(
          Object.entries(answers).map(([id, a]) => [id, { type: 'boolean' as const, probability: a.noul }]),
        ),
        usage: {
          ...(usage?.input_tokens != null && { inputTokens: usage.input_tokens }),
          ...(usage?.output_tokens != null && { outputTokens: usage.output_tokens }),
        },
        warnings: [],
        response: {
          modelId: model ?? config.model,
          body: rawValue,
          ...(responseHeaders !== undefined && { headers: responseHeaders }),
        },
      };
    },
  };
}
