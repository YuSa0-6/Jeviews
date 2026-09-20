// TypeSafe 直結。POST /v1/systemone に state と questions を送り、answers を返す。
// 出典: https://docs.typesafe.ai/api.md 、 https://docs.typesafe.ai/introduction/quickstart.md

import { postJsonWithRetry, type HttpOptions } from './http.js';
import { ProviderError, type NoulAnswer, type Provider, type SystemOneResponse } from '../../review/ports.js';

export interface TypeSafeOptions extends HttpOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

const DEFAULT_MODEL = 'jev-latest';
const DEFAULT_BASE_URL = 'https://api.typesafe.ai';
/** 出典: https://docs.typesafe.ai/models.md の価格。入力トークンのみ課金。 */
const USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;

export function createTypeSafeProvider(opts: TypeSafeOptions): Provider {
  const model = opts.model ?? DEFAULT_MODEL;
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');

  return {
    model,
    usdPerInputToken: USD_PER_INPUT_TOKEN,
    async ask(state, questions) {
      const { body, status, attempts } = await postJsonWithRetry(
        `${baseUrl}/v1/systemone`,
        { Authorization: `Bearer ${opts.apiKey}` },
        { model, state, questions },
        opts,
      );
      if (!isSystemOneResponse(body)) {
        const err = new ProviderError('invalid_response', 'unexpected response shape', status);
        err.attempts = attempts;
        throw err;
      }
      return { response: body, attempts };
    },
  };
}

function isSystemOneResponse(v: unknown): v is SystemOneResponse {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o['answers'] !== 'object' || o['answers'] === null) return false;
  return Object.values(o['answers'] as Record<string, unknown>).every(isNoulAnswer);
}

function isNoulAnswer(a: unknown): a is NoulAnswer {
  if (typeof a !== 'object' || a === null) return false;
  const ans = a as Record<string, unknown>;
  return ans['type'] === 'noul' && typeof ans['noul'] === 'number';
}
