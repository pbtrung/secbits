import { beforeAll, describe, expect, it } from 'vitest';
import leancrypto from '../../public/leancrypto/leancrypto.js';
import { bytesToB64, decryptBlobBytes, encryptBytesToBlob } from '../crypto.js';

const SALT_LEN = 64;
const TAG_LEN = 64;

beforeAll(() => {
  globalThis.leancrypto = leancrypto;
});

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

describe('bytesToB64', () => {
  it('converts a known byte array to the expected base64 string', () => {
    const bytes = new Uint8Array([0, 1, 255]);
    expect(bytesToB64(bytes)).toBe('AAH/');
  });

  it('round-trips bytes through base64 encoding and decoding', () => {
    const bytes = new Uint8Array([0, 1, 255]);
    const b64 = bytesToB64(bytes);
    const decoded = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    expect(decoded.length).toBe(bytes.length);
    for (let i = 0; i < bytes.length; i++) {
      expect(decoded[i]).toBe(bytes[i]);
    }
  });
});
