import { beforeAll, describe, expect, it } from 'vitest';
import leancrypto from '../../public/leancrypto/leancrypto.js';
import { unwrapEntryKey, wrapEntryKey } from '../crypto.js';

const DOC_KEY_LEN = 64;
const BLOB_LEN = 192; // SALT(64) + ciphertext(64) + TAG(64)

beforeAll(() => {
  globalThis.leancrypto = leancrypto;
});

describe('wrapEntryKey / unwrapEntryKey', () => {
  it('wrapped blob is 192 bytes', async () => {
    const userMasterKey = crypto.getRandomValues(new Uint8Array(64));
    const docKey = crypto.getRandomValues(new Uint8Array(DOC_KEY_LEN));
    const blob = await wrapEntryKey(userMasterKey, docKey);
    expect(blob).toBeInstanceOf(Uint8Array);
    expect(blob.length).toBe(BLOB_LEN);
  });

  it('unwrap recovers the doc key byte-by-byte', async () => {
    const userMasterKey = crypto.getRandomValues(new Uint8Array(64));
    const docKey = crypto.getRandomValues(new Uint8Array(DOC_KEY_LEN));
    const blob = await wrapEntryKey(userMasterKey, docKey);
    const recovered = await unwrapEntryKey(userMasterKey, blob);
    expect(recovered.length).toBe(DOC_KEY_LEN);
    for (let i = 0; i < DOC_KEY_LEN; i++) {
      expect(recovered[i]).toBe(docKey[i]);
    }
  });

  it('rejects a 32-byte docKey with "docKeyBytes must be 64 bytes"', async () => {
    const userMasterKey = crypto.getRandomValues(new Uint8Array(64));
    const shortDocKey = new Uint8Array(32);
    await expect(wrapEntryKey(userMasterKey, shortDocKey)).rejects.toThrow('docKeyBytes must be 64 bytes');
  });

  it('rejects a tampered blob', async () => {
    const userMasterKey = crypto.getRandomValues(new Uint8Array(64));
    const docKey = crypto.getRandomValues(new Uint8Array(DOC_KEY_LEN));
    const blob = await wrapEntryKey(userMasterKey, docKey);
    const tampered = blob.slice();
    tampered[tampered.length - 1] ^= 0x01;
    await expect(unwrapEntryKey(userMasterKey, tampered)).rejects.toThrow();
  });
});
