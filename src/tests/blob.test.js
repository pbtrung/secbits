import { describe, expect, it } from 'vitest';
import {
  BLOB_AD_LEN,
  BLOB_MAGIC,
  BLOB_MIN_LEN,
  BLOB_SALT_LEN,
  BLOB_TAG_LEN,
  BLOB_VERSION,
  buildBlob,
  parseBlob,
} from '../lib/blob.js';

describe('blob build/parse', () => {
  it('round-trips all fields', () => {
    const salt = crypto.getRandomValues(new Uint8Array(BLOB_SALT_LEN));
    const ciphertext = crypto.getRandomValues(new Uint8Array(100));
    const tag = crypto.getRandomValues(new Uint8Array(BLOB_TAG_LEN));
    const blob = buildBlob({ salt, ciphertext, tag });
    const parsed = parseBlob(blob);
    expect(parsed.version).toEqual(BLOB_VERSION);
    expect(parsed.salt).toEqual(salt);
    expect(parsed.ciphertext).toEqual(ciphertext);
    expect(parsed.tag).toEqual(tag);
  });

  it('fails on magic mismatch before crypto', () => {
    const salt = crypto.getRandomValues(new Uint8Array(BLOB_SALT_LEN));
    const ciphertext = new Uint8Array(1);
    const tag = crypto.getRandomValues(new Uint8Array(BLOB_TAG_LEN));
    const blob = buildBlob({ salt, ciphertext, tag });
    blob[0] = 0x58; // "X"
    blob[1] = 0x59; // "Y"
    expect(() => parseBlob(blob)).toThrow();
  });

  it('rejects blobs shorter than minimum length', () => {
    expect(() => parseBlob(new Uint8Array(BLOB_MIN_LEN - 1))).toThrow();
  });

  it('extracts version bytes correctly', () => {
    const salt = crypto.getRandomValues(new Uint8Array(BLOB_SALT_LEN));
    const tag = crypto.getRandomValues(new Uint8Array(BLOB_TAG_LEN));
    const blob = buildBlob({ version: new Uint8Array([0x01, 0x23]), salt, ciphertext: new Uint8Array(0), tag });
    const parsed = parseBlob(blob);
    expect(parsed.version).toEqual(new Uint8Array([0x01, 0x23]));
  });

  it('sets AD to magic||version||salt with exact 68-byte length', () => {
    const salt = crypto.getRandomValues(new Uint8Array(BLOB_SALT_LEN));
    const tag = crypto.getRandomValues(new Uint8Array(BLOB_TAG_LEN));
    const blob = buildBlob({ salt, ciphertext: new Uint8Array(10), tag });
    const parsed = parseBlob(blob);
    expect(parsed.ad).toHaveLength(BLOB_AD_LEN);
    expect(parsed.ad.slice(0, 2)).toEqual(BLOB_MAGIC);
    expect(parsed.ad.slice(2, 4)).toEqual(BLOB_VERSION);
    expect(parsed.ad.slice(4)).toEqual(salt);
  });
});
