import { describe, expect, it } from 'vitest';
import { randomBytes } from '@noble/ciphers/utils.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha3_512 } from '@noble/hashes/sha3.js';
import { hmac } from '@noble/hashes/hmac.js';
import { decryptBlobBytes, encryptBytesToBlob } from './crypto.js';

const SALT_LEN = 64;
const HMAC_LEN = 64;
const ENC_KEY_LEN = 32;
const ENC_IV_LEN = 24;
const HKDF_OUT_LEN = ENC_KEY_LEN + ENC_IV_LEN + HMAC_LEN;

function deriveHmacForBlob(keyBytes, blob) {
  const salt = blob.slice(0, SALT_LEN);
  const ciphertext = blob.slice(SALT_LEN, blob.length - HMAC_LEN);
  const derived = hkdf(sha3_512, keyBytes, salt, new Uint8Array(), HKDF_OUT_LEN);
  const hmacKey = derived.slice(ENC_KEY_LEN + ENC_IV_LEN);

  const macInput = new Uint8Array(salt.length + ciphertext.length);
  macInput.set(salt, 0);
  macInput.set(ciphertext, salt.length);

  return hmac(sha3_512, hmacKey, macInput);
}

describe('encryptBytesToBlob / decryptBlobBytes', () => {
  it('round-trips 128 random bytes byte-by-byte', () => {
    const keyBytes = randomBytes(64);
    const plain = randomBytes(128);

    const c = encryptBytesToBlob(keyBytes, plain);
    const d = decryptBlobBytes(keyBytes, c);

    expect(d.length).toBe(plain.length);
    for (let i = 0; i < plain.length; i++) {
      expect(d[i]).toBe(plain[i]);
    }
  });

  it('stores HMAC-SHA3-512 that matches user-master-key format (salt || ciphertext)', () => {
    const keyBytes = randomBytes(64);
    const plain = randomBytes(128);

    const c = encryptBytesToBlob(keyBytes, plain);
    const storedMac = c.slice(c.length - HMAC_LEN);
    const computedMac = deriveHmacForBlob(keyBytes, c);

    expect(storedMac.length).toBe(HMAC_LEN);
    expect(Array.from(storedMac)).toEqual(Array.from(computedMac));
  });

  it('rejects modified blobs when HMAC does not verify', () => {
    const keyBytes = randomBytes(64);
    const plain = randomBytes(128);

    const c = encryptBytesToBlob(keyBytes, plain);
    const tampered = c.slice();
    tampered[tampered.length - 1] ^= 0x01;

    expect(() => decryptBlobBytes(keyBytes, tampered)).toThrow('Invalid encrypted value MAC');
  });
});
