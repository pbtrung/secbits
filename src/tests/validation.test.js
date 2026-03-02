import { describe, expect, it } from 'vitest';
import { validateConfig, validateRootMasterKey, validateZBase32Id, isHttpsUrl } from '../lib/validation.js';

function makeB64(length) {
  const bytes = new Uint8Array(length);
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str);
}

describe('validation', () => {
  it('root_master_key accepts valid base64 >= 256 bytes and rejects short', () => {
    expect(validateRootMasterKey(makeB64(256))).toBe(true);
    expect(validateRootMasterKey(makeB64(300))).toBe(true);
    expect(validateRootMasterKey(makeB64(255))).toBe(false);
    expect(validateRootMasterKey('!!!bad')).toBe(false);
  });

  it('worker_url accepts HTTPS and rejects HTTP', () => {
    expect(isHttpsUrl('https://example.com')).toBe(true);
    expect(isHttpsUrl('http://example.com')).toBe(false);
  });

  it('z-base-32 id validation enforces 52 chars and alphabet', () => {
    expect(validateZBase32Id('3rd65irghj1jkh68ybpcqq4jprhs5cip9rpaytwgb79tssdddugo')).toBe(true);
    expect(validateZBase32Id('short')).toBe(false);
    expect(validateZBase32Id('3rd65irghj1jkh68ybpcqq4jprhs5cip9rpaytwgb79tssdddug!')).toBe(false);
  });

  it('config validation checks required fields', () => {
    const ok = validateConfig({
      worker_url: 'https://w.example.workers.dev',
      email: 'u@example.com',
      password: 'pw',
      firebase_api_key: 'x',
      root_master_key: makeB64(256),
    });
    expect(ok).toEqual([]);

    const bad = validateConfig({
      worker_url: 'http://bad',
      email: '',
      firebase_api_key: '',
      root_master_key: 'x',
    });
    expect(bad.length).toBeGreaterThan(0);
  });
});
