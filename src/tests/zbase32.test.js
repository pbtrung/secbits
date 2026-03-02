import { describe, expect, it } from 'vitest';
import { zbase32Decode, zbase32Encode } from '../lib/zbase32.js';

describe('z-base-32', () => {
  it('round-trips random 256-bit input', () => {
    const input = crypto.getRandomValues(new Uint8Array(32));
    const encoded = zbase32Encode(input);
    const decoded = zbase32Decode(encoded);
    expect(decoded).toEqual(input);
  });

  it('encodes a known 32-byte vector to 52 chars', () => {
    const input = new Uint8Array(32);
    for (let i = 0; i < input.length; i++) input[i] = i;
    const encoded = zbase32Encode(input);
    expect(encoded).toBe('yyyoryarywdyqnyjbefoadeqbhebnrounoktcfaadrpbs8y7daxo');
    expect(encoded).toHaveLength(52);
  });

  it('rejects non-alphabet characters', () => {
    expect(() => zbase32Decode('invalid!')).toThrow();
  });

  it('rejects malformed length/bit tail', () => {
    // 51 chars cannot represent a valid 256-bit payload.
    const valid = zbase32Encode(new Uint8Array(32));
    expect(() => zbase32Decode(valid.slice(0, -1))).toThrow();
  });
});
