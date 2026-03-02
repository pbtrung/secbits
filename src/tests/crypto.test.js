import { beforeAll, describe, expect, it } from 'vitest';
import leancrypto from '../../leancrypto/leancrypto.js';
import { bytesToB64, decryptBlobBytes, decryptEntry, encryptBytesToBlob, encryptEntry, generateEntryKey } from '../lib/crypto.js';
import { computeCommitHash } from '../lib/commitHash.js';
import { BLOB_MAGIC, BLOB_SALT_LEN, BLOB_TAG_LEN } from '../lib/blob.js';

const MAGIC = BLOB_MAGIC;
const MAGIC_LEN = BLOB_MAGIC.length;
const VERSION_LEN = 2;
const HEADER_LEN = MAGIC_LEN + VERSION_LEN; // 4
const SALT_LEN = BLOB_SALT_LEN;
const TAG_LEN = BLOB_TAG_LEN;

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

  it('blob has correct size, magic header, and non-zero AEAD tag', async () => {
    const keyBytes = crypto.getRandomValues(new Uint8Array(64));
    const plain = crypto.getRandomValues(new Uint8Array(128));

    const c = await encryptBytesToBlob(keyBytes, plain);

    expect(c.length).toBe(HEADER_LEN + SALT_LEN + plain.length + TAG_LEN);

    // magic bytes = "SB"
    for (let i = 0; i < MAGIC_LEN; i++) {
      expect(c[i]).toBe(MAGIC[i]);
    }

    // version = 1.0
    expect(c[MAGIC_LEN]).toBe(0x01);
    expect(c[MAGIC_LEN + 1]).toBe(0x00);

    const tag = c.slice(c.length - TAG_LEN);
    expect(tag.length).toBe(TAG_LEN);
    expect(tag.some(b => b !== 0)).toBe(true);
  });

  it('rejects tampered ciphertext with authentication failure', async () => {
    const keyBytes = crypto.getRandomValues(new Uint8Array(64));
    const plain = crypto.getRandomValues(new Uint8Array(128));

    const c = await encryptBytesToBlob(keyBytes, plain);
    const tampered = c.slice();
    tampered[tampered.length - 1] ^= 0x01;

    await expect(decryptBlobBytes(keyBytes, tampered)).rejects.toThrow();
  });

  it('rejects tampered salt with authentication failure', async () => {
    const keyBytes = crypto.getRandomValues(new Uint8Array(64));
    const plain = crypto.getRandomValues(new Uint8Array(128));

    const c = await encryptBytesToBlob(keyBytes, plain);
    const tampered = c.slice();
    tampered[HEADER_LEN] ^= 0x01; // flip first salt byte

    await expect(decryptBlobBytes(keyBytes, tampered)).rejects.toThrow();
  });

  it('rejects tampered version byte with authentication failure', async () => {
    const keyBytes = crypto.getRandomValues(new Uint8Array(64));
    const plain = crypto.getRandomValues(new Uint8Array(128));

    const c = await encryptBytesToBlob(keyBytes, plain);
    const tampered = c.slice();
    tampered[MAGIC_LEN] ^= 0x01; // flip major version byte

    await expect(decryptBlobBytes(keyBytes, tampered)).rejects.toThrow();
  });

  it('rejects any single-byte blob modification', async () => {
    const keyBytes = crypto.getRandomValues(new Uint8Array(64));
    const plain = crypto.getRandomValues(new Uint8Array(48));
    const blob = await encryptBytesToBlob(keyBytes, plain);

    for (let i = 0; i < blob.length; i++) {
      const tampered = blob.slice();
      tampered[i] ^= 0x01;
      await expect(decryptBlobBytes(keyBytes, tampered)).rejects.toThrow();
    }
  });
});

describe('encryptEntry / decryptEntry', () => {
  it('round-trips all three entry types', async () => {
    const entries = [
      { type: 'login', title: 'GitHub', username: 'alice', password: 's3cr3t', urls: ['https://github.com'], tags: ['work'] },
      { type: 'note', title: 'Meeting notes', notes: 'discussed roadmap' },
      { type: 'card', title: 'Visa', card_number: '4111111111111111', expiry: '12/28', cvv: '123' },
    ];
    for (const entry of entries) {
      const key = generateEntryKey();
      const blob = await encryptEntry(entry, key);
      const recovered = await decryptEntry(blob, key);
      expect(recovered).toEqual(entry);
    }
  });

  it('commit hash field survives round-trip inside snapshot', async () => {
    const snapshot = { type: 'login', title: 'Test', username: 'u' };
    const hash = await computeCommitHash(snapshot);
    const withHash = { ...snapshot, commit_hash: hash };
    const key = generateEntryKey();
    const blob = await encryptEntry(withHash, key);
    const recovered = await decryptEntry(blob, key);
    expect(recovered.commit_hash).toBe(hash);
    // Verify hash is consistent: recompute from snapshot without the field
    const recomputed = await computeCommitHash(snapshot);
    expect(recovered.commit_hash).toBe(recomputed);
  });

  it('wrong entry_key throws at AEAD tag check', async () => {
    const key = generateEntryKey();
    const wrong = generateEntryKey();
    const blob = await encryptEntry({ type: 'note', title: 'x' }, key);
    await expect(decryptEntry(blob, wrong)).rejects.toThrow();
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
