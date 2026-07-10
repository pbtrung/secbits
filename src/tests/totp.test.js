import { describe, expect, it } from 'vitest';
import { base32Decode, generateTOTP, generateTOTPForCounter } from '../lib/totp.js';

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

  it('different secrets produce different codes for the same counter', () => {
    const other = 'JBSWY3DPEHPK3PXP'; // "Hello!" in base32
    expect(generateTOTPForCounter(SECRET_BASE32, 1)).not.toBe(generateTOTPForCounter(other, 1));
  });

  it('adjacent 30-second windows (consecutive counters) differ', () => {
    const counter = 37037036;
    expect(generateTOTPForCounter(SECRET_BASE32, counter)).not.toBe(
      generateTOTPForCounter(SECRET_BASE32, counter + 1),
    );
  });
});

describe('base32Decode', () => {
  // RFC 6238 SHA-1 secret: ASCII "12345678901234567890"
  const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  const RFC_HEX = '3132333435363738393031323334353637383930';

  function toHex(bytes) {
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  it('decodes the RFC 6238 SHA-1 secret to the correct bytes', () => {
    const decoded = base32Decode(RFC_SECRET);
    expect(decoded).not.toBeNull();
    expect(toHex(decoded)).toBe(RFC_HEX);
  });

  it('strips = padding characters silently', () => {
    const withPadding = base32Decode(RFC_SECRET + '====');
    expect(withPadding).toEqual(base32Decode(RFC_SECRET));
  });

  it('strips space, dash, and underscore separators', () => {
    const mixed = RFC_SECRET.slice(0, 8) + ' ' + RFC_SECRET.slice(8, 16) + '-' + RFC_SECRET.slice(16, 24) + '_' + RFC_SECRET.slice(24);
    expect(base32Decode(mixed)).toEqual(base32Decode(RFC_SECRET));
  });

  it('is case-insensitive', () => {
    expect(base32Decode(RFC_SECRET.toLowerCase())).toEqual(base32Decode(RFC_SECRET));
  });

  it('returns null for strings containing invalid base32 characters', () => {
    expect(base32Decode('0189!')).toBeNull();
  });
});

describe('generateTOTP', () => {
  it('returns a 6-digit string for a valid secret', () => {
    const result = generateTOTP('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(result).toMatch(/^\d{6}$/);
  });

  it('returns null for an invalid secret', () => {
    expect(generateTOTP('!!!invalid')).toBeNull();
  });
});
