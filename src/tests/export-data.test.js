import { describe, expect, it } from 'vitest';
import { buildExportData } from '../components/SettingsPanel.jsx';

describe('buildExportData', () => {
  it('uses explicit export fields and omits stored user-master-key fields', () => {
    const exportData = buildExportData({
      userId: 'u1',
      userData: {
        username: 'alice',
        user_master_key: { toUint8Array: () => new Uint8Array([1, 2, 3]) },
      },
      userMasterKey: new Uint8Array([4, 5, 6]),
      decryptedDocs: [],
    });

    expect(exportData).toMatchObject({
      user_id: 'u1',
      username: 'alice',
      user_master_key_b64: 'BAUG',
      data: [],
    });
    expect(Object.prototype.hasOwnProperty.call(exportData, 'user_master_key')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(exportData, 'stored_user_master_key_blob_b64')).toBe(false);
  });
});
