// TypeSafe 直結。POST /v1/systemone に state と questions を送り、answers を返す。
// 出典: https://docs.typesafe.ai/api.md 、 https://docs.typesafe.ai/introduction/quickstart.md

export interface NoulQuestion {
  type: 'noul';
  instructions: string;
}

export type Question = NoulQuestion;

export interface NoulAnswer {
  type: 'noul';
  noul: number;
}

export interface SystemOneResponse {
  model: string;
  answers: Record<string, NoulAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export interface ProviderResult {
  response: SystemOneResponse;
  /** この呼び出しで送った HTTP リクエスト数。再試行を含む。 */
  attempts: number;
}

export interface Provider {
  ask(state: unknown, questions: Record<string, Question>): Promise<ProviderResult>;
}

export class ProviderError extends Error {
  constructor(
    readonly code: 'auth' | 'bad_request' | 'rate_limit' | 'server' | 'network' | 'invalid_response',
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export interface TypeSafeOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  maxAttempts?: number;
  fetchImpl?: typeof fetch;
  /** テスト用。既定は実時間の待機。 */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MODEL = 'jev-latest';
const DEFAULT_BASE_URL = 'https://api.typesafe.ai';

export function createTypeSafeProvider(opts: TypeSafeOptions): Provider & { model: string } {
  const model = opts.model ?? DEFAULT_MODEL;
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const maxAttempts = opts.maxAttempts ?? 3;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  return {
    model,
    async ask(state, questions) {
      let attempts = 0;
      let lastError: ProviderError | undefined;
      while (attempts < maxAttempts) {
        attempts += 1;
        let res: Response;
        try {
          res = await fetchImpl(`${baseUrl}/v1/systemone`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${opts.apiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ model, state, questions }),
          });
        } catch (e) {
          lastError = new ProviderError('network', (e as Error).message);
          await sleep(backoffMs(attempts));
          continue;
        }

        if (res.ok) {
          const body = (await res.json()) as unknown;
          if (!isSystemOneResponse(body)) {
            throw new ProviderError('invalid_response', 'unexpected response shape', res.status);
          }
          return { response: body, attempts };
        }

        const text = await res.text().catch(() => '');
        if (res.status === 401 || res.status === 403) {
          throw new ProviderError('auth', `authentication failed: ${text}`, res.status);
        }
        if (res.status === 400 || res.status === 404 || res.status === 422) {
          throw new ProviderError('bad_request', `bad request: ${text}`, res.status);
        }
        if (res.status === 429) {
          lastError = new ProviderError('rate_limit', `rate limited: ${text}`, res.status);
          await sleep(retryAfterMs(res.headers.get('retry-after')) ?? backoffMs(attempts));
          continue;
        }
        lastError = new ProviderError('server', `server error ${res.status}: ${text}`, res.status);
        await sleep(backoffMs(attempts));
      }
      // attempts を呼び出し側へ伝えるため、エラーに載せる。
      const err = lastError ?? new ProviderError('network', 'exhausted attempts');
      (err as ProviderError & { attempts?: number }).attempts = attempts;
      throw err;
    },
  };
}

function backoffMs(attempt: number): number {
  return Math.min(8000, 500 * 2 ** (attempt - 1));
}

function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

function isSystemOneResponse(v: unknown): v is SystemOneResponse {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o['answers'] !== 'object' || o['answers'] === null) return false;
  for (const a of Object.values(o['answers'] as Record<string, unknown>)) {
    if (typeof a !== 'object' || a === null) return false;
    const ans = a as Record<string, unknown>;
    if (ans['type'] !== 'noul' || typeof ans['noul'] !== 'number') return false;
  }
  return true;
}
