import { describe, expect, it } from 'vitest';
import { decryptBlobBytes, encryptBytesToBlob } from './crypto.js';

const SALT_LEN = 64;
const TAG_LEN = 64;

describe('encryptBytesToBlob / decryptBlobBytes', () => {
  it('round-trips 128 random bytes byte-by-byte', async () => {
    const keyBytes = crypto.getRandomValues(new Uint8Array(64));
    const plain = crypto.getRandomValues(new Uint8Array(128));

    const c = await encryptBytesToBlob(keyBytes, plain);
    const d = await decryptBlobBytes(keyBytes, c);

    expect(d.length).toBe(plain.length);
    for (let i = 0; i < plain.length; i++) {
      expect(d[i]).toBe(plain[i]);
    }
  });

  it('blob has correct size and non-zero AEAD tag', async () => {
    const keyBytes = crypto.getRandomValues(new Uint8Array(64));
    const plain = crypto.getRandomValues(new Uint8Array(128));

    const c = await encryptBytesToBlob(keyBytes, plain);

    expect(c.length).toBe(SALT_LEN + plain.length + TAG_LEN);

    const tag = c.slice(c.length - TAG_LEN);
    expect(tag.length).toBe(TAG_LEN);
    expect(tag.some(b => b !== 0)).toBe(true);
  });

  it('rejects tampered blobs with authentication failure', async () => {
    const keyBytes = crypto.getRandomValues(new Uint8Array(64));
    const plain = crypto.getRandomValues(new Uint8Array(128));

    const c = await encryptBytesToBlob(keyBytes, plain);
    const tampered = c.slice();
    tampered[tampered.length - 1] ^= 0x01;

    await expect(decryptBlobBytes(keyBytes, tampered)).rejects.toThrow();
  });
});
