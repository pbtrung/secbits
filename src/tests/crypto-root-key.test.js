import { describe, expect, it } from 'vitest';
import { decodeRootMasterKey } from '../lib/crypto.js';

function makeB64(length) {
  const bytes = new Uint8Array(length);
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str);
}

describe('decodeRootMasterKey', () => {
  it('accepts a 256-byte key and returns a Uint8Array of length 256', () => {
    const result = decodeRootMasterKey(makeB64(256));
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBe(256);
  });

  it('accepts a 300-byte key (over the minimum)', () => {
    const result = decodeRootMasterKey(makeB64(300));
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBe(300);
  });

  it('rejects a 255-byte key with an "at least 256 bytes" error', () => {
    expect(() => decodeRootMasterKey(makeB64(255))).toThrow('at least 256 bytes');
  });

  it('rejects an invalid base64 string', () => {
    expect(() => decodeRootMasterKey('!!!invalid')).toThrow();
  });
});
