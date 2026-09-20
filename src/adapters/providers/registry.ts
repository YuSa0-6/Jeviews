// 接続先の一覧。provider を増やすときはここに 1 行足す。
// 環境変数の名前と生成関数をひとまとめにし、cli 側の分岐を無くす。

import type { ProviderId } from '../../review/output.js';
import type { Provider } from '../../review/ports.js';
import { createTypeSafeProvider } from './typesafe.js';
import { createVercelGatewayProvider } from './vercel-gateway.js';

export interface ProviderOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

interface ProviderEntry {
  /** API キーを入れる環境変数。あればこの provider が候補になる */
  keyEnv: string;
  /** 接続先を上書きする環境変数 (任意) */
  baseUrlEnv: string;
  create(opts: ProviderOptions): Provider;
}

/** 並び順がそのまま自動選択の優先順位。両方の鍵があれば先頭が勝つ。 */
export const PROVIDERS: ReadonlyArray<readonly [ProviderId, ProviderEntry]> = [
  ['typesafe', { keyEnv: 'TYPESAFE_API_KEY', baseUrlEnv: 'TYPESAFE_BASE_URL', create: createTypeSafeProvider }],
  ['vercel-gateway', { keyEnv: 'AI_GATEWAY_API_KEY', baseUrlEnv: 'AI_GATEWAY_BASE_URL', create: createVercelGatewayProvider }],
];

export function isProviderId(v: string): v is ProviderId {
  return PROVIDERS.some(([id]) => id === v);
}

/** 明示されないときの接続先。鍵がある最初の provider。 */
export function detectProvider(env: NodeJS.ProcessEnv): ProviderId | undefined {
  return PROVIDERS.find(([, e]) => env[e.keyEnv])?.[0];
}

/** 環境変数から provider を組み立てる。鍵が無い、URL が壊れている場合は Error。 */
export function createProviderFromEnv(id: ProviderId, model: string | undefined, env: NodeJS.ProcessEnv): Provider {
  const entry = PROVIDERS.find(([pid]) => pid === id)![1];
  const apiKey = env[entry.keyEnv];
  if (!apiKey) throw new Error(`${entry.keyEnv} is not set`);
  const opts: ProviderOptions = { apiKey };
  if (model) opts.model = model;
  const baseUrl = env[entry.baseUrlEnv];
  if (baseUrl) {
    if (!URL.canParse(baseUrl)) throw new Error(`${entry.baseUrlEnv} is not a valid URL: "${baseUrl}"`);
    opts.baseUrl = baseUrl;
  }
  return entry.create(opts);
}
