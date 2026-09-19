import { describe, expect, it } from 'vitest';
import { ProviderError } from './provider.js';
import { createTypeSafeProvider } from './typesafe.js';
import { createVercelGatewayProvider } from './vercel-gateway.js';

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** 1 回目の呼び出しを記録し、決めた応答を返す fetch。 */
function fakeFetch(responses: Array<{ status: number; body: unknown; headers?: Record<string, string> }>) {
  const calls: Captured[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body)),
    });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)]!;
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { 'content-type': 'application/json', ...(r.headers ?? {}) },
    });
  };
  return { calls, fetchImpl };
}

const noSleep = async () => {};
const questions = { q1__problem: { type: 'noul' as const, instructions: 'Is it broken?' } };

describe('createVercelGatewayProvider', () => {
  it('posts to /evaluation-model with the gateway headers and boolean questions', async () => {
    const { calls, fetchImpl } = fakeFetch([
      { status: 200, body: { answers: { q1__problem: { type: 'boolean', probability: 0.42 } }, usage: { inputTokens: 120, outputTokens: 0 } } },
    ]);
    const p = createVercelGatewayProvider({ apiKey: 'k', fetchImpl, sleep: noSleep });
    const { response, attempts } = await p.ask({ path: 'a.ts', content: 'x' }, questions);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://ai-gateway.vercel.sh/v4/ai/evaluation-model');
    expect(calls[0]!.headers).toMatchObject({
      Authorization: 'Bearer k',
      'ai-gateway-protocol-version': '0.0.1',
      'ai-gateway-auth-method': 'api-key',
      'ai-evaluation-model-specification-version': '4',
      'ai-model-id': 'typesafe-ai/jev',
    });
    expect(calls[0]!.body).toEqual({
      state: { path: 'a.ts', content: 'x' },
      questions: { q1__problem: { type: 'boolean', instructions: 'Is it broken?' } },
    });
    expect(response.answers).toEqual({ q1__problem: { type: 'noul', noul: 0.42 } });
    expect(response.usage).toEqual({ input_tokens: 120, output_tokens: 0 });
    expect(attempts).toBe(1);
    expect(p.model).toBe('typesafe-ai/jev');
    expect(p.usdPerInputToken).toBeNull();
  });

  it('rejects answers that are not boolean probabilities', async () => {
    const { fetchImpl } = fakeFetch([{ status: 200, body: { answers: { q1__problem: { type: 'choice', choice: 'a' } } } }]);
    const p = createVercelGatewayProvider({ apiKey: 'k', fetchImpl, sleep: noSleep });
    await expect(p.ask({}, questions)).rejects.toMatchObject({ code: 'invalid_response', attempts: 1 });
  });
});

describe('createTypeSafeProvider', () => {
  it('posts to /v1/systemone with the model in the body', async () => {
    const { calls, fetchImpl } = fakeFetch([
      { status: 200, body: { model: 'jev-latest', answers: { q1__problem: { type: 'noul', noul: 0.1 } } } },
    ]);
    const p = createTypeSafeProvider({ apiKey: 'k', fetchImpl, sleep: noSleep });
    const { response } = await p.ask({ content: 'x' }, questions);
    expect(calls[0]!.url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(calls[0]!.headers).toMatchObject({ Authorization: 'Bearer k' });
    expect(calls[0]!.body).toEqual({ model: 'jev-latest', state: { content: 'x' }, questions });
    expect(response.answers['q1__problem']?.noul).toBe(0.1);
    expect(p.usdPerInputToken).toBeCloseTo(0.042 / 1_000_000, 12);
  });

  it('retries on 429 and reports the attempt count on the error', async () => {
    const { calls, fetchImpl } = fakeFetch([{ status: 429, body: { error: 'slow down' }, headers: { 'retry-after': '0' } }]);
    const p = createTypeSafeProvider({ apiKey: 'k', fetchImpl, sleep: noSleep, maxAttempts: 3 });
    const err = await p.ask({}, questions).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ code: 'rate_limit', attempts: 3 });
    expect(calls).toHaveLength(3);
  });

  it('does not retry on 401', async () => {
    const { calls, fetchImpl } = fakeFetch([{ status: 401, body: { error: 'nope' } }]);
    const p = createTypeSafeProvider({ apiKey: 'k', fetchImpl, sleep: noSleep });
    await expect(p.ask({}, questions)).rejects.toMatchObject({ code: 'auth', attempts: 1 });
    expect(calls).toHaveLength(1);
  });
});
