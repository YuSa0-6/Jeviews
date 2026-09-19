// JSON を POST して JSON を受け取る。再試行の方針はここに一本化する。
//   429 と 5xx と通信エラー: 待って再試行 (429 は Retry-After を優先)
//   401/403: auth、400/404/422: bad_request として即座に失敗
// 投げる ProviderError には attempts を載せ、呼び出し側が usage.requests に数えられるようにする。

import { ProviderError } from './provider.js';

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

  let attempts = 0;
  let lastError: ProviderError | undefined;
  while (attempts < maxAttempts) {
    attempts += 1;
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
    } catch (e) {
      lastError = new ProviderError('network', (e as Error).message);
      await sleep(backoffMs(attempts));
      continue;
    }

    if (res.ok) {
      let json: unknown;
      try {
        json = await res.json();
      } catch (e) {
        throw withAttempts(new ProviderError('invalid_response', `response is not JSON: ${(e as Error).message}`, res.status), attempts);
      }
      return { body: json, status: res.status, headers: res.headers, attempts };
    }

    const text = await res.text().catch(() => '');
    if (res.status === 401 || res.status === 403) {
      throw withAttempts(new ProviderError('auth', `authentication failed: ${text}`, res.status), attempts);
    }
    if (res.status === 400 || res.status === 404 || res.status === 422) {
      throw withAttempts(new ProviderError('bad_request', `bad request: ${text}`, res.status), attempts);
    }
    if (res.status === 429) {
      lastError = new ProviderError('rate_limit', `rate limited: ${text}`, res.status);
      await sleep(retryAfterMs(res.headers.get('retry-after')) ?? backoffMs(attempts));
      continue;
    }
    lastError = new ProviderError('server', `server error ${res.status}: ${text}`, res.status);
    await sleep(backoffMs(attempts));
  }
  throw withAttempts(lastError ?? new ProviderError('network', 'exhausted attempts'), attempts);
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
