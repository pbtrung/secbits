import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args) => invokeMock(...args),
}));

import {
  createEntry,
  getVaultStats,
  rotateMasterKey,
  unlockVaultSession,
} from '../api.js';

describe('api wrappers', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('calls unlock_vault', async () => {
    invokeMock.mockResolvedValue(undefined);
    await unlockVaultSession();
    expect(invokeMock).toHaveBeenCalledWith('unlock_vault', undefined);
  });

  it('calls create_entry with expected args', async () => {
    invokeMock.mockResolvedValue({ id: 1 });
    await createEntry('login', { title: 'x' });
    expect(invokeMock).toHaveBeenCalledWith('create_entry', expect.objectContaining({
      entryType: 'login',
      entry_type: 'login',
      snapshot: { title: 'x' },
    }));
  });

  it('calls rotate_master_key', async () => {
    invokeMock.mockResolvedValue(undefined);
    await rotateMasterKey('Zm9v');
    expect(invokeMock).toHaveBeenCalledWith('rotate_master_key', expect.objectContaining({
      newKeyB64: 'Zm9v',
      new_key_b64: 'Zm9v',
    }));
  });

  it('calls get_vault_stats', async () => {
    invokeMock.mockResolvedValue({ entryCount: 0 });
    await getVaultStats();
    expect(invokeMock).toHaveBeenCalledWith('get_vault_stats', undefined);
  });
});
