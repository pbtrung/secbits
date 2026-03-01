import { describe, expect, it } from 'vitest';
import { base32Decode, generateTOTP, generateTOTPForCounter } from '../totp.js';

const SECRET_BASE32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('generateTOTPForCounter', () => {
  it('matches RFC 6238 vectors', () => {
    expect(generateTOTPForCounter(SECRET_BASE32, 1)).toBe('287082');
    expect(generateTOTPForCounter(SECRET_BASE32, 37037036)).toBe('081804');
    expect(generateTOTPForCounter(SECRET_BASE32, 37037037)).toBe('050471');
    expect(generateTOTPForCounter(SECRET_BASE32, 41152263)).toBe('005924');
  });

  it('returns null for invalid secrets', () => {
    expect(generateTOTPForCounter('NOT-BASE32*', 1)).toBeNull();
  });
});

describe('base32Decode', () => {
  it('decodes a valid secret', () => {
    const decoded = base32Decode(SECRET_BASE32);
    expect(decoded).toBeInstanceOf(Uint8Array);
    expect(decoded.length).toBeGreaterThan(0);
  });

  it('is case insensitive', () => {
    expect(base32Decode(SECRET_BASE32.toLowerCase())).toEqual(base32Decode(SECRET_BASE32));
  });

  it('rejects bad chars', () => {
    expect(base32Decode('0189!')).toBeNull();
  });
});

describe('generateTOTP', () => {
  it('returns 6 digit code', () => {
    expect(generateTOTP(SECRET_BASE32)).toMatch(/^\d{6}$/);
  });
});
