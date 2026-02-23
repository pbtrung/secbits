import { beforeAll, describe, expect, it } from 'vitest';
import leancrypto from '../../public/leancrypto/leancrypto.js';
import { setupUserMasterKey, verifyUserMasterKey } from '../crypto.js';

const MASTER_BLOB_LEN = 192; // SALT(64) + UMK(64) + TAG(64)

beforeAll(() => {
  globalThis.leancrypto = leancrypto;
});

describe('setupUserMasterKey / verifyUserMasterKey', () => {
  it('setup returns a 192-byte blob', async () => {
    const rootKey = crypto.getRandomValues(new Uint8Array(256));
    const { userMasterKeyBlob } = await setupUserMasterKey(rootKey);
    expect(userMasterKeyBlob).toBeInstanceOf(Uint8Array);
    expect(userMasterKeyBlob.length).toBe(MASTER_BLOB_LEN);
  });

  it('verify recovers the UMK byte-by-byte', async () => {
    const rootKey = crypto.getRandomValues(new Uint8Array(256));
    const { userMasterKeyBlob, userMasterKey } = await setupUserMasterKey(rootKey);
    const recovered = await verifyUserMasterKey(rootKey, userMasterKeyBlob);
    expect(recovered.length).toBe(userMasterKey.length);
    for (let i = 0; i < userMasterKey.length; i++) {
      expect(recovered[i]).toBe(userMasterKey[i]);
    }
  });

  it('rejects a wrong root master key', async () => {
    const rootKey = crypto.getRandomValues(new Uint8Array(256));
    const { userMasterKeyBlob } = await setupUserMasterKey(rootKey);
    const wrongKey = crypto.getRandomValues(new Uint8Array(256));
    await expect(verifyUserMasterKey(wrongKey, userMasterKeyBlob)).rejects.toThrow('Wrong root master key');
  });

  it('rejects a blob shorter than 192 bytes', async () => {
    const rootKey = crypto.getRandomValues(new Uint8Array(256));
    const shortBlob = new Uint8Array(100);
    await expect(verifyUserMasterKey(rootKey, shortBlob)).rejects.toThrow('Invalid stored user_master_key data');
  });
});
