// JSON を POST して JSON を受け取る。再試行の方針はここに一本化する。
//   429 と 5xx と通信エラー: 待って再試行 (429 は Retry-After を優先)
//   401/403: auth、400/404/422: bad_request として即座に失敗
// 投げる ProviderError には attempts を載せ、呼び出し側が usage.requests に数えられるようにする。

import { ProviderError } from '../../review/ports.js';

export interface HttpOptions {
  maxAttempts?: number;
  fetchImpl?: typeof fetch;
  /** テスト用。既定は実時間の待機。 */
  sleep?: (ms: number) => Promise<void>;
}

export interface PostJsonResult {
  body: unknown;
  status: number;
  headers: Headers;
  attempts: number;
}

export async function postJsonWithRetry(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  opts: HttpOptions = {},
): Promise<PostJsonResult> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const init = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  };

  let lastError: ProviderError | undefined;
  for (let attempts = 1; attempts <= maxAttempts; attempts++) {
    const res = await fetchImpl(url, init).catch((e: Error) => new ProviderError('network', e.message));
    if (res instanceof ProviderError) {
      lastError = res;
      await sleep(backoffMs(attempts));
      continue;
    }
    if (res.ok) {
      return { body: await parseJson(res, attempts), status: res.status, headers: res.headers, attempts };
    }
    const failure = await classifyFailure(res);
    if (!failure.retry) throw withAttempts(failure.error, attempts);
    lastError = failure.error;
    await sleep(failure.waitMs ?? backoffMs(attempts));
  }
  throw withAttempts(lastError ?? new ProviderError('network', 'exhausted attempts'), maxAttempts);
}

async function parseJson(res: Response, attempts: number): Promise<unknown> {
  try {
    return await res.json();
  } catch (e) {
    throw withAttempts(new ProviderError('invalid_response', `response is not JSON: ${(e as Error).message}`, res.status), attempts);
  }
}

interface Failure {
  error: ProviderError;
  retry: boolean;
  waitMs?: number;
}

async function classifyFailure(res: Response): Promise<Failure> {
  const text = await res.text().catch(() => '');
  const s = res.status;
  if (s === 401 || s === 403) return { error: new ProviderError('auth', `authentication failed: ${text}`, s), retry: false };
  if (s === 400 || s === 404 || s === 422) return { error: new ProviderError('bad_request', `bad request: ${text}`, s), retry: false };
  if (s === 429) {
    const f: Failure = { error: new ProviderError('rate_limit', `rate limited: ${text}`, s), retry: true };
    const wait = retryAfterMs(res.headers.get('retry-after'));
    if (wait !== undefined) f.waitMs = wait;
    return f;
  }
  return { error: new ProviderError('server', `server error ${s}: ${text}`, s), retry: true };
}

function withAttempts(err: ProviderError, attempts: number): ProviderError {
  err.attempts = attempts;
  return err;
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
