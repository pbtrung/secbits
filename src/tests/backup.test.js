import { beforeAll, describe, expect, it } from 'vitest';
import leancrypto from '../../leancrypto/leancrypto.js';
import { buildCloudBackupBlob } from '../lib/backup.js';
import { decryptEntry } from '../crypto.js';

beforeAll(() => {
  globalThis.leancrypto = leancrypto;
});

describe('buildCloudBackupBlob', () => {
  it('round-trips an export object under the backup master key', async () => {
    const key = crypto.getRandomValues(new Uint8Array(64));
    const exportObj = {
      version: 1,
      username: 'jane',
      user_master_key: 'abc',
      data: [{ id: '1', title: 'x', entry_key: 'k1' }],
      trash: [],
    };
    const blob = await buildCloudBackupBlob(exportObj, key);
    const recovered = await decryptEntry(blob, key);
    expect(recovered).toEqual(exportObj);
  });

  it('fails to decrypt under a different backup master key', async () => {
    const key = crypto.getRandomValues(new Uint8Array(64));
    const wrong = crypto.getRandomValues(new Uint8Array(64));
    const blob = await buildCloudBackupBlob({ version: 1, data: [] }, key);
    await expect(decryptEntry(blob, wrong)).rejects.toThrow();
  });
});
