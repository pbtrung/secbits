import { beforeAll, describe, expect, it } from 'vitest';
import leancrypto from '../../public/leancrypto/leancrypto.js';
import { decryptEntryHistoryWithDocKey, encryptEntryHistoryWithDocKey } from '../crypto.js';

beforeAll(() => {
  globalThis.leancrypto = leancrypto;
});

describe('encryptEntryHistoryWithDocKey / decryptEntryHistoryWithDocKey', () => {
  const sampleHistory = {
    title: 'test entry',
    password: 'secret123',
    notes: 'some notes',
    urls: ['https://example.com'],
    commits: [
      { hash: 'abc', parent: null, timestamp: '2026-01-01T00:00:00.000Z', changed: [], snapshot: {} },
      { hash: 'def', parent: 'abc', timestamp: '2026-01-02T00:00:00.000Z', changed: ['password'], snapshot: {} },
    ],
  };

  it('round-trips history through Brotli compression and AEAD encryption', async () => {
    const docKey = crypto.getRandomValues(new Uint8Array(64));
    const encryptedBlob = await encryptEntryHistoryWithDocKey(docKey, sampleHistory);
    const decrypted = await decryptEntryHistoryWithDocKey(docKey, encryptedBlob);
    expect(decrypted).toEqual(sampleHistory);
  });

  it('rejects tampered blobs before returning any plaintext', async () => {
    const docKey = crypto.getRandomValues(new Uint8Array(64));
    const encryptedBlob = await encryptEntryHistoryWithDocKey(docKey, sampleHistory);
    const tampered = encryptedBlob.slice();
    // Flip a byte in the ciphertext region (after the 64-byte salt)
    tampered[64] ^= 0x01;
    await expect(decryptEntryHistoryWithDocKey(docKey, tampered)).rejects.toThrow();
  });
});
