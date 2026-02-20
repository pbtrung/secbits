import { describe, expect, it } from 'vitest';
import { generateTOTPForCounter } from '../totp.js';

// RFC 6238 test secret for SHA-1: ASCII "12345678901234567890"
const SECRET_BASE32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('generateTOTPForCounter', () => {
  it('matches RFC 6238 vector for T=59s (counter=1)', () => {
    expect(generateTOTPForCounter(SECRET_BASE32, 1)).toBe('287082');
  });

  it('matches RFC 6238 vectors around 2005-03-18', () => {
    expect(generateTOTPForCounter(SECRET_BASE32, 37037036)).toBe('081804');
    expect(generateTOTPForCounter(SECRET_BASE32, 37037037)).toBe('050471');
  });

  it('matches RFC 6238 vectors for large counters', () => {
    expect(generateTOTPForCounter(SECRET_BASE32, 41152263)).toBe('005924');
    expect(generateTOTPForCounter(SECRET_BASE32, 66666666)).toBe('279037');
    expect(generateTOTPForCounter(SECRET_BASE32, 666666666)).toBe('353130');
  });

  it('rejects secrets containing invalid base32 characters', () => {
    expect(generateTOTPForCounter(`${SECRET_BASE32}!`, 1)).toBeNull();
    expect(generateTOTPForCounter('NOT-BASE32*', 1)).toBeNull();
  });
});
