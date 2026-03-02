import { beforeAll, describe, expect, it } from 'vitest';
import leancrypto from '../../leancrypto/leancrypto.js';
import {
  decryptEntry,
  decryptEntryKey,
  decryptUMK,
  encryptEntry,
  encryptEntryKey,
  encryptUMK,
  generateEntryKey,
} from '../lib/crypto.js';

beforeAll(() => {
  globalThis.leancrypto = leancrypto;
});

describe('key hierarchy', () => {
  it('UMK round-trip works and wrong RMK fails', async () => {
    const rmk = crypto.getRandomValues(new Uint8Array(256));
    const wrong = crypto.getRandomValues(new Uint8Array(256));
    const umk = crypto.getRandomValues(new Uint8Array(64));

    const blob = await encryptUMK(umk, rmk);
    await expect(decryptUMK(blob, wrong)).rejects.toThrow();
    await expect(decryptUMK(blob, rmk)).resolves.toEqual(umk);
  });

  it('entry key round-trip works and wrong UMK fails', async () => {
    const umk = crypto.getRandomValues(new Uint8Array(64));
    const wrong = crypto.getRandomValues(new Uint8Array(64));
    const entryKey = generateEntryKey();

    const blob = await encryptEntryKey(entryKey, umk);
    await expect(decryptEntryKey(blob, wrong)).rejects.toThrow();
    await expect(decryptEntryKey(blob, umk)).resolves.toEqual(entryKey);
  });

  it('full 3-level round-trip recovers original JSON', async () => {
    const rmk = crypto.getRandomValues(new Uint8Array(256));
    const rawUmk = crypto.getRandomValues(new Uint8Array(64));
    const rawEntryKey = generateEntryKey();
    const entry = { type: 'login', title: 'GitHub', username: 'alice', tags: ['work'] };

    const umkBlob = await encryptUMK(rawUmk, rmk);
    const entryKeyBlob = await encryptEntryKey(rawEntryKey, rawUmk);
    const entryBlob = await encryptEntry(entry, rawEntryKey);

    const recoveredUmk = await decryptUMK(umkBlob, rmk);
    const recoveredEntryKey = await decryptEntryKey(entryKeyBlob, recoveredUmk);
    const recoveredEntry = await decryptEntry(entryBlob, recoveredEntryKey);
    expect(recoveredEntry).toEqual(entry);
  });

  it('same input encrypts to different blobs because salt is fresh', async () => {
    const key = crypto.getRandomValues(new Uint8Array(64));
    const entry = { type: 'note', title: 'N', notes: 'same' };
    const a = await encryptEntry(entry, key);
    const b = await encryptEntry(entry, key);
    expect(a).not.toEqual(b);
  });

  it('tamper at entry_key blob throws before decryptEntry is reached', async () => {
    const umk = crypto.getRandomValues(new Uint8Array(64));
    const entryKey = generateEntryKey();

    const entryKeyBlob = await encryptEntryKey(entryKey, umk);
    const tampered = entryKeyBlob.slice();
    tampered[tampered.length - 1] ^= 0x01;

    await expect(decryptEntryKey(tampered, umk)).rejects.toThrow();
  });

  it('tamper at entry data blob throws on decryptEntry', async () => {
    const entryKey = generateEntryKey();
    const entry = { type: 'note', title: 'Tamper test' };

    const entryBlob = await encryptEntry(entry, entryKey);
    const tampered = entryBlob.slice();
    tampered[tampered.length - 1] ^= 0x01;

    await expect(decryptEntry(tampered, entryKey)).rejects.toThrow();
  });
});
