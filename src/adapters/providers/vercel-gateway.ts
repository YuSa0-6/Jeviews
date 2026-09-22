// Vercel AI Gateway 経由で Jev を呼ぶ。https://vercel.com/ai-gateway/models/jev
//
// Gateway の評価 API は AI SDK の内部プロトコルで、公開 REST 文書はまだない。
// 通信形式は @ai-sdk/gateway@4.0.87 の dist/index.js (GatewayEvaluationModel) から写した。
//   POST {baseUrl}/evaluation-model
//   headers: Authorization: Bearer <AI_GATEWAY_API_KEY>
//            ai-gateway-protocol-version: 0.0.1
//            ai-gateway-auth-method: api-key
//            ai-evaluation-model-specification-version: 4
//            ai-model-id: typesafe-ai/jev
//   body:    { state, questions }   質問の型は 'boolean' (TypeSafe 直結の 'noul' に相当)
//   answer:  { type: 'boolean', probability }  usage: { inputTokens, outputTokens }
// review 側は TypeSafe 直結と同じ形 (noul) だけを見るので、ここで読み替える。
// 価格は Gateway 側の設定に依存し固定でないため usdPerInputToken は null。

import {
  type NoulAnswer,
  type Provider,
  ProviderError,
  type Question,
  type SystemOneResponse,
} from '../../review/ports.js';
import { type HttpOptions, postJsonWithRetry } from './http.js';

export interface VercelGatewayOptions extends HttpOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

const DEFAULT_MODEL = 'typesafe-ai/jev';
const DEFAULT_BASE_URL = 'https://ai-gateway.vercel.sh/v4/ai';
const PROTOCOL_VERSION = '0.0.1';
const EVALUATION_SPEC_VERSION = '4';

interface GatewayBooleanAnswer {
  type: 'boolean';
  probability: number;
}

interface GatewayEvaluationResponse {
  answers: Record<string, GatewayBooleanAnswer>;
  usage?: { inputTokens?: number; outputTokens?: number };
  rounding?: { probabilityDecimals?: number };
  warnings?: unknown[];
}

export function createVercelGatewayProvider(opts: VercelGatewayOptions): Provider {
  const model = opts.model ?? DEFAULT_MODEL;
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');

  return {
    model,
    usdPerInputToken: null,
    async ask(state, questions) {
      const { body, status, attempts } = await postJsonWithRetry(
        `${baseUrl}/evaluation-model`,
        {
          Authorization: `Bearer ${opts.apiKey}`,
          'ai-gateway-protocol-version': PROTOCOL_VERSION,
          'ai-gateway-auth-method': 'api-key',
          'ai-evaluation-model-specification-version': EVALUATION_SPEC_VERSION,
          'ai-model-id': model,
        },
        { state, questions: toGatewayQuestions(questions) },
        opts,
      );
      if (!isGatewayResponse(body)) {
        const err = new ProviderError('invalid_response', 'unexpected response shape', status);
        err.attempts = attempts;
        throw err;
      }
      const answers: Record<string, NoulAnswer> = {};
      for (const [id, a] of Object.entries(body.answers)) answers[id] = { type: 'noul', noul: a.probability };
      const response: SystemOneResponse = {
        model,
        answers,
      };
      if (body.usage) {
        response.usage = {};
        if (typeof body.usage.inputTokens === 'number') response.usage.input_tokens = body.usage.inputTokens;
        if (typeof body.usage.outputTokens === 'number') response.usage.output_tokens = body.usage.outputTokens;
      }
      return { response, attempts };
    },
  };
}

function toGatewayQuestions(
  questions: Record<string, Question>,
): Record<string, { type: 'boolean'; instructions: string }> {
  const out: Record<string, { type: 'boolean'; instructions: string }> = {};
  for (const [id, q] of Object.entries(questions)) out[id] = { type: 'boolean', instructions: q.instructions };
  return out;
}

function isGatewayResponse(v: unknown): v is GatewayEvaluationResponse {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o['answers'] !== 'object' || o['answers'] === null) return false;
  return Object.values(o['answers'] as Record<string, unknown>).every((a) => {
    if (typeof a !== 'object' || a === null) return false;
    const ans = a as Record<string, unknown>;
    return ans['type'] === 'boolean' && typeof ans['probability'] === 'number';
  });
}
