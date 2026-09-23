import type { ProviderId } from '../../review/output.js';
import type { Provider } from '../../review/ports.js';
import { createTypeSafeProvider } from './typesafe.js';
import { createVercelGatewayProvider } from './vercel-gateway.js';

interface ProviderOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

interface ProviderEntry {
  keyEnv: string;
  baseUrlEnv: string;
  create(opts: ProviderOptions): Provider;
}

const PROVIDERS: ReadonlyArray<readonly [ProviderId, ProviderEntry]> = [
  ['typesafe', { keyEnv: 'TYPESAFE_API_KEY', baseUrlEnv: 'TYPESAFE_BASE_URL', create: createTypeSafeProvider }],
  [
    'vercel-gateway',
    { keyEnv: 'AI_GATEWAY_API_KEY', baseUrlEnv: 'AI_GATEWAY_BASE_URL', create: createVercelGatewayProvider },
  ],
];

export function isProviderId(v: string): v is ProviderId {
  return PROVIDERS.some(([id]) => id === v);
}

export function detectProvider(env: NodeJS.ProcessEnv): ProviderId | undefined {
  return PROVIDERS.find(([, e]) => env[e.keyEnv])?.[0];
}

export function createProviderFromEnv(id: ProviderId, model: string | undefined, env: NodeJS.ProcessEnv): Provider {
  const entry = PROVIDERS.find(([pid]) => pid === id)?.[1];
  if (!entry) throw new Error(`unsupported provider: ${id}`);
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
