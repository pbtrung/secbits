import { describe, expect, it } from 'vitest';
import { isHttpUrl } from '../validation.js';

describe('isHttpUrl', () => {
  it('accepts http and https URLs', () => {
    expect(isHttpUrl('https://example.com')).toBe(true);
    expect(isHttpUrl('http://example.com/path?a=1')).toBe(true);
  });

  it('rejects non-http(s) schemes', () => {
    expect(isHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpUrl('data:text/html,hello')).toBe(false);
    expect(isHttpUrl('file:///tmp/x')).toBe(false);
  });

  it('rejects malformed values', () => {
    expect(isHttpUrl('')).toBe(false);
    expect(isHttpUrl('not a url')).toBe(false);
    expect(isHttpUrl(null)).toBe(false);
  });
});
