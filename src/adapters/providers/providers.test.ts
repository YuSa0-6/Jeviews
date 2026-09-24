import { describe, expect, it } from 'vitest';
import { ProviderError } from '../../review/ports.js';
import { createTypeSafeProvider } from './typesafe.js';
import { createVercelGatewayProvider } from './vercel-gateway.js';

interface Captured {
  url: string;
  headers: Headers;
  body: unknown;
}

/** 呼び出しを記録し、決めた応答を順に返す (尽きたら最後を繰り返す) fetch。 */
function fakeFetch(responses: Array<{ status: number; body: unknown; headers?: Record<string, string> }>) {
  const calls: Captured[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)]!;
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { 'content-type': 'application/json', ...(r.headers ?? {}) },
    });
  };
  return { calls, fetch };
}

const questions = { q1__problem: { type: 'noul' as const, instructions: 'Is it broken?' } };

describe('createVercelGatewayProvider', () => {
  it('asks the gateway evaluation model and reads answers back as noul', async () => {
    const { calls, fetch } = fakeFetch([
      {
        status: 200,
        body: {
          answers: { q1__problem: { type: 'boolean', probability: 0.42 } },
          usage: { inputTokens: 120, outputTokens: 0 },
        },
      },
    ]);
    const p = createVercelGatewayProvider({ apiKey: 'k', fetch });
    const { response, attempts } = await p.ask({ path: 'a.ts', content: 'x' }, questions);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://ai-gateway.vercel.sh/v4/ai/evaluation-model');
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer k');
    expect(calls[0]!.headers.get('ai-model-id')).toBe('typesafe-ai/jev');
    expect(response.answers).toEqual({ q1__problem: { type: 'noul', noul: 0.42 } });
    expect(response.usage).toEqual({ input_tokens: 120, output_tokens: 0 });
    expect(attempts).toBe(1);
    expect(p.model).toBe('typesafe-ai/jev');
    expect(p.usdPerInputToken).toBeNull();
  });

  it('rejects answers that are not boolean probabilities without retrying', async () => {
    const { calls, fetch } = fakeFetch([
      { status: 200, body: { answers: { q1__problem: { type: 'choice', choice: 'a' } } } },
    ]);
    const p = createVercelGatewayProvider({ apiKey: 'k', fetch });
    await expect(p.ask({}, questions)).rejects.toMatchObject({ code: 'invalid_response', attempts: 1 });
    expect(calls).toHaveLength(1);
  });

  it('reports a failed connection as network, not the 500 the gateway wraps it in', async () => {
    const fetch: typeof globalThis.fetch = async () => {
      throw new TypeError('fetch failed');
    };
    const p = createVercelGatewayProvider({ apiKey: 'k', fetch, maxRetries: 0 });
    await expect(p.ask({}, questions)).rejects.toMatchObject({ code: 'network', attempts: 1 });
  });
});

describe('createTypeSafeProvider', () => {
  it('posts to /v1/systemone with the model and noul questions', async () => {
    const { calls, fetch } = fakeFetch([
      { status: 200, body: { model: 'jev-latest', answers: { q1__problem: { type: 'noul', noul: 0.1 } } } },
    ]);
    const p = createTypeSafeProvider({ apiKey: 'k', fetch });
    const { response } = await p.ask({ content: 'x' }, questions);
    expect(calls[0]!.url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer k');
    expect(calls[0]!.body).toMatchObject({ model: 'jev-latest', state: { content: 'x' }, questions });
    expect(response.answers['q1__problem']?.noul).toBe(0.1);
    expect(p.usdPerInputToken).toBeCloseTo(0.042 / 1_000_000, 12);
  });

  it('keeps TYPESAFE_BASE_URL as the host and appends /v1', async () => {
    const { calls, fetch } = fakeFetch([
      { status: 200, body: { model: 'm', answers: { q1__problem: { type: 'noul', noul: 0 } } } },
    ]);
    await createTypeSafeProvider({ apiKey: 'k', baseUrl: 'https://proxy.example/', fetch }).ask({}, questions);
    expect(calls[0]!.url).toBe('https://proxy.example/v1/systemone');
  });

  it('retries on 429 honoring Retry-After and reports the attempt count on the error', async () => {
    const { calls, fetch } = fakeFetch([
      { status: 429, body: { error: 'slow down' }, headers: { 'retry-after': '0' } },
    ]);
    const p = createTypeSafeProvider({ apiKey: 'k', fetch, maxRetries: 2 });
    const err = await p.ask({}, questions).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ code: 'rate_limit', status: 429, attempts: 3 });
    expect(calls).toHaveLength(3);
  });

  it('counts attempts per call even when asks run concurrently', async () => {
    const { fetch } = fakeFetch([
      { status: 500, body: {}, headers: { 'retry-after': '0' } },
      { status: 200, body: { model: 'm', answers: { q1__problem: { type: 'noul', noul: 0.5 } } } },
    ]);
    const p = createTypeSafeProvider({ apiKey: 'k', fetch });
    const [a, b] = await Promise.all([p.ask({}, questions), p.ask({}, questions)]);
    expect(a.attempts + b.attempts).toBe(3);
  });

  it('reports a failed connection as network', async () => {
    const fetch: typeof globalThis.fetch = async () => {
      throw new TypeError('fetch failed');
    };
    const p = createTypeSafeProvider({ apiKey: 'k', fetch, maxRetries: 0 });
    await expect(p.ask({}, questions)).rejects.toMatchObject({ code: 'network', attempts: 1 });
  });

  it('does not retry on 401', async () => {
    const { calls, fetch } = fakeFetch([{ status: 401, body: { error: 'nope' } }]);
    const p = createTypeSafeProvider({ apiKey: 'k', fetch });
    await expect(p.ask({}, questions)).rejects.toMatchObject({ code: 'auth', attempts: 1 });
    expect(calls).toHaveLength(1);
  });

  it('reports an oversized input (400) as bad_request without retrying', async () => {
    const { calls, fetch } = fakeFetch([{ status: 400, body: { error: 'too long' } }]);
    const p = createTypeSafeProvider({ apiKey: 'k', fetch });
    await expect(p.ask({}, questions)).rejects.toMatchObject({ code: 'bad_request', status: 400, attempts: 1 });
    expect(calls).toHaveLength(1);
  });
});
