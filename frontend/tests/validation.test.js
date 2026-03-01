import { describe, expect, it } from 'vitest';
import {
  isHttpUrl,
  validateCardNumber,
  validateExpiry,
  validateTitle,
  validateTotpSecret,
  validateUrl,
} from '../validation.js';

describe('validation', () => {
  it('validates title required', () => {
    expect(validateTitle('')).toBe('Title is required');
    expect(validateTitle('ok')).toBeNull();
  });

  it('validates URL format', () => {
    expect(isHttpUrl('https://example.com')).toBe(true);
    expect(isHttpUrl('javascript:alert(1)')).toBe(false);
    expect(validateUrl('ftp://x')).toContain('Invalid URL');
  });

  it('validates TOTP base32', () => {
    expect(validateTotpSecret('JBSWY3DPEHPK3PXP')).toBeNull();
    expect(validateTotpSecret('abc!')).toContain('Invalid base32');
  });

  it('validates card formats', () => {
    expect(validateExpiry('12/30')).toBeNull();
    expect(validateExpiry('13/30')).toContain('Invalid expiry');
    expect(validateCardNumber('4111 1111 1111 1111')).toBeNull();
    expect(validateCardNumber('1234')).toContain('Invalid card number');
  });
});
