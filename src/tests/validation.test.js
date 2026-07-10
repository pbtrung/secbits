import { describe, expect, it } from 'vitest';
import { validateConfig, validateRootMasterKey, isHttpsUrl, isHttpUrl } from '../lib/validation.js';

function makeB64(length) {
  const bytes = new Uint8Array(length);
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str);
}

function validConfig(overrides = {}) {
  return {
    instant_app_id: 'app-id',
    instant_client_name: 'firebase',
    email: 'u@example.com',
    password: 'pw',
    firebase_api_key: 'x',
    username: 'Jane Doe',
    root_master_key: makeB64(256),
    ...overrides,
  };
}

describe('validation', () => {
  it('root_master_key accepts valid base64 >= 256 bytes and rejects short', () => {
    expect(validateRootMasterKey(makeB64(256))).toBe(true);
    expect(validateRootMasterKey(makeB64(300))).toBe(true);
    expect(validateRootMasterKey(makeB64(255))).toBe(false);
    expect(validateRootMasterKey('!!!bad')).toBe(false);
  });

  it('accepts HTTPS and rejects HTTP', () => {
    expect(isHttpsUrl('https://example.com')).toBe(true);
    expect(isHttpsUrl('http://example.com')).toBe(false);
  });

  it('isHttpUrl accepts both HTTP and HTTPS, rejects other schemes and non-strings', () => {
    expect(isHttpUrl('https://example.com')).toBe(true);
    expect(isHttpUrl('http://example.com')).toBe(true);
    expect(isHttpUrl('ftp://example.com')).toBe(false);
    expect(isHttpUrl('not a url')).toBe(false);
    expect(isHttpUrl(null)).toBe(false);
    expect(isHttpUrl(42)).toBe(false);
  });

  it('config validation accepts a fully populated config', () => {
    expect(validateConfig(validConfig())).toEqual([]);
  });

  it('config validation flags missing required fields', () => {
    const bad = validateConfig({
      instant_app_id: '',
      email: '',
      firebase_api_key: '',
      root_master_key: 'x',
    });
    expect(bad.length).toBeGreaterThan(0);
  });

  it('r2_config is only validated when present', () => {
    expect(validateConfig(validConfig())).toEqual([]);
    const bad = validateConfig(validConfig({ r2_config: { bucket: 'b' } }));
    expect(bad).toContain('R2 account ID is required');
    expect(bad).toContain('R2 access key ID is required');
  });

  it('s3_config must be an array, validated per destination', () => {
    const notArray = validateConfig(validConfig({ s3_config: { endpoint: 'https://x' } }));
    expect(notArray).toContain('S3 destinations must be a list');

    const missingFields = validateConfig(validConfig({ s3_config: [{ endpoint: 'https://x' }] }));
    expect(missingFields).toContain('S3 destination 1 region is required');
    expect(missingFields).toContain('S3 destination 1 bucket is required');

    const ok = validateConfig(validConfig({
      backup_master_key: makeB64(256),
      s3_config: [{
        endpoint: 'https://s3.us-west-1.amazonaws.com',
        region: 'us-west-1',
        bucket: 'b',
        access_key_id: 'k',
        secret_access_key: 's',
      }],
    }));
    expect(ok).toEqual([]);
  });

  it('backup_master_key is required only once a cloud destination is configured', () => {
    expect(validateConfig(validConfig({ r2_config: undefined, s3_config: undefined }))).toEqual([]);

    const missing = validateConfig(validConfig({ r2_config: { account_id: 'a', bucket: 'b', access_key_id: 'k', secret_access_key: 's' } }));
    expect(missing).toContain('Backup master key must be base64 and at least 256 bytes decoded');

    const ok = validateConfig(validConfig({
      backup_master_key: makeB64(256),
      r2_config: { account_id: 'a', bucket: 'b', access_key_id: 'k', secret_access_key: 's' },
    }));
    expect(ok).toEqual([]);
  });
});
