import { describe, expect, it } from 'vitest';
import { createProviderFromEnv, detectProvider, isProviderId } from './registry.js';

describe('detectProvider', () => {
  it('prefers typesafe when both keys are set', () => {
    expect(detectProvider({ TYPESAFE_API_KEY: 'a', AI_GATEWAY_API_KEY: 'b' })).toBe('typesafe');
  });
  it('falls back to vercel-gateway when only its key is set', () => {
    expect(detectProvider({ AI_GATEWAY_API_KEY: 'b' })).toBe('vercel-gateway');
  });
  it('returns undefined when no key is set', () => {
    expect(detectProvider({})).toBeUndefined();
    expect(detectProvider({ TYPESAFE_API_KEY: '' })).toBeUndefined();
  });
});

describe('isProviderId', () => {
  it('accepts known ids and rejects others', () => {
    expect(isProviderId('typesafe')).toBe(true);
    expect(isProviderId('vercel-gateway')).toBe(true);
    expect(isProviderId('openai')).toBe(false);
  });
});

describe('createProviderFromEnv', () => {
  it('names the missing env var', () => {
    expect(() => createProviderFromEnv('vercel-gateway', undefined, {})).toThrow('AI_GATEWAY_API_KEY is not set');
  });
  it('rejects a malformed base URL', () => {
    expect(() => createProviderFromEnv('typesafe', undefined, { TYPESAFE_API_KEY: 'k', TYPESAFE_BASE_URL: 'nope' })).toThrow(
      'TYPESAFE_BASE_URL is not a valid URL',
    );
  });
  it('applies the model override', () => {
    const p = createProviderFromEnv('vercel-gateway', 'custom/model', { AI_GATEWAY_API_KEY: 'k' });
    expect(p.model).toBe('custom/model');
  });
});
