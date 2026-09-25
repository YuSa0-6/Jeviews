import type { ProviderId } from '../../review/output.js';
import type { Provider } from '../../review/ports.js';
import { createCloudflareProvider } from './cloudflare.js';
import { createOpenRouterProvider } from './openrouter.js';
import { createTypeSafeProvider } from './typesafe.js';
import { createVercelGatewayProvider } from './vercel-gateway.js';

interface ProviderOptions {
  apiKey: string;
  accountId?: string;
  model?: string;
  baseUrl?: string;
}

interface ProviderEntry {
  keyEnv: string;
  /** キーのほかに必須の、アカウント ID を入れる環境変数。 */
  accountIdEnv?: string;
  baseUrlEnv: string;
  /** true なら --provider で指名されたときだけ使う。キーがあっても自動では選ばない。 */
  explicitOnly?: boolean;
  create(opts: ProviderOptions): Provider;
}

const PROVIDERS: ReadonlyArray<readonly [ProviderId, ProviderEntry]> = [
  ['typesafe', { keyEnv: 'TYPESAFE_API_KEY', baseUrlEnv: 'TYPESAFE_BASE_URL', create: createTypeSafeProvider }],
  [
    'vercel-gateway',
    { keyEnv: 'AI_GATEWAY_API_KEY', baseUrlEnv: 'AI_GATEWAY_BASE_URL', create: createVercelGatewayProvider },
  ],
  ['openrouter', { keyEnv: 'OPENROUTER_API_KEY', baseUrlEnv: 'OPENROUTER_BASE_URL', create: createOpenRouterProvider }],
  [
    'cloudflare',
    {
      keyEnv: 'CLOUDFLARE_API_TOKEN',
      accountIdEnv: 'CLOUDFLARE_ACCOUNT_ID',
      baseUrlEnv: 'CLOUDFLARE_BASE_URL',
      // wrangler と同じ変数名で、AI 以外の用途でも環境に置かれていることが多い。知らないうちにコードを送らないよう指名制にする。
      explicitOnly: true,
      create: createCloudflareProvider,
    },
  ],
];

export function isProviderId(v: string): v is ProviderId {
  return PROVIDERS.some(([id]) => id === v);
}

export function detectProvider(env: NodeJS.ProcessEnv): ProviderId | undefined {
  return PROVIDERS.find(([, e]) => !e.explicitOnly && env[e.keyEnv])?.[0];
}

export function createProviderFromEnv(id: ProviderId, model: string | undefined, env: NodeJS.ProcessEnv): Provider {
  const entry = PROVIDERS.find(([pid]) => pid === id)?.[1];
  if (!entry) throw new Error(`unsupported provider: ${id}`);
  const opts: ProviderOptions = { apiKey: requiredEnv(env, entry.keyEnv) };
  if (entry.accountIdEnv) opts.accountId = requiredEnv(env, entry.accountIdEnv);
  if (model) opts.model = model;
  const baseUrl = env[entry.baseUrlEnv];
  if (baseUrl) {
    if (!URL.canParse(baseUrl)) throw new Error(`${entry.baseUrlEnv} is not a valid URL: "${baseUrl}"`);
    opts.baseUrl = baseUrl;
  }
  return entry.create(opts);
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}
