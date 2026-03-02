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

describe('key rotation', () => {
  it('RMK rotation re-encrypts UMK and old RMK no longer decrypts', async () => {
    const oldRMK = crypto.getRandomValues(new Uint8Array(256));
    const newRMK = crypto.getRandomValues(new Uint8Array(256));
    const rawUMK = crypto.getRandomValues(new Uint8Array(64));

    const oldBlob = await encryptUMK(rawUMK, oldRMK);
    const newBlob = await encryptUMK(await decryptUMK(oldBlob, oldRMK), newRMK);

    await expect(decryptUMK(newBlob, oldRMK)).rejects.toThrow();
    await expect(decryptUMK(newBlob, newRMK)).resolves.toEqual(rawUMK);
  });

  it('UMK rotation rewraps entry keys while entry/history ciphertext stays unchanged', async () => {
    const oldUMK = crypto.getRandomValues(new Uint8Array(64));
    const newUMK = crypto.getRandomValues(new Uint8Array(64));
    const rawEntryKey = generateEntryKey();

    const entry = { type: 'note', title: 'a', notes: 'b' };
    const snap = { ...entry, commit_hash: 'abcd' };
    const entryBlob = await encryptEntry(entry, rawEntryKey);
    const snapshotBlob = await encryptEntry(snap, rawEntryKey);

    const oldWrapped = await encryptEntryKey(rawEntryKey, oldUMK);
    const newWrapped = await encryptEntryKey(await decryptEntryKey(oldWrapped, oldUMK), newUMK);

    expect(entryBlob).toEqual(entryBlob);
    expect(snapshotBlob).toEqual(snapshotBlob);
    await expect(decryptEntryKey(newWrapped, oldUMK)).rejects.toThrow();
    await expect(decryptEntryKey(newWrapped, newUMK)).resolves.toEqual(rawEntryKey);
    await expect(decryptEntry(entryBlob, rawEntryKey)).resolves.toEqual(entry);
  });

  it('interrupted UMK rewrap is retriable and converges', async () => {
    const oldUMK = crypto.getRandomValues(new Uint8Array(64));
    const newUMK = crypto.getRandomValues(new Uint8Array(64));
    const keys = Array.from({ length: 10 }, () => generateEntryKey());
    const wrapped = await Promise.all(keys.map((k) => encryptEntryKey(k, oldUMK)));

    // first attempt updates only first 5
    for (let i = 0; i < 5; i++) {
      const raw = await decryptEntryKey(wrapped[i], oldUMK);
      wrapped[i] = await encryptEntryKey(raw, newUMK);
    }
    // retry updates remaining
    for (let i = 5; i < 10; i++) {
      const raw = await decryptEntryKey(wrapped[i], oldUMK);
      wrapped[i] = await encryptEntryKey(raw, newUMK);
    }

    for (let i = 0; i < 10; i++) {
      await expect(decryptEntryKey(wrapped[i], newUMK)).resolves.toEqual(keys[i]);
      await expect(decryptEntryKey(wrapped[i], oldUMK)).rejects.toThrow();
    }
  });
});
