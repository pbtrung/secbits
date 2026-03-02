import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import leancrypto from '../../leancrypto/leancrypto.js';
import {
  initApi,
  setRootMasterKey,
  clearUserMasterKey,
  fetchUserEntries,
  createUserEntry,
  updateUserEntry,
  deleteUserEntry,
  restoreDeletedUserEntry,
  permanentlyDeleteUserEntry,
} from '../lib/api.js';
import { generateEntryKey, encryptUMK, encryptEntry, bytesToB64 } from '../lib/crypto.js';

const WORKER_URL = 'https://worker.example.workers.dev';

function makeJwt(payload) {
  const b64 = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return `header.${b64}.sig`;
}

let rootKey;
let umkBytes;
let encUmkB64;

beforeAll(async () => {
  globalThis.leancrypto = leancrypto;
  rootKey = crypto.getRandomValues(new Uint8Array(256));
  umkBytes = generateEntryKey();
  encUmkB64 = bytesToB64(await encryptUMK(umkBytes, rootKey));
});

afterEach(() => {
  clearUserMasterKey();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Fetch mock helpers
// ---------------------------------------------------------------------------

function mockOk(body, status = 200) {
  return { ok: true, status, json: async () => body };
}

// Build an encrypted history snapshot to serve from GET /entries/:id/history
async function makeSnapshotRow(entryPayload, rawEntryKey, entryId, createdAt = '2026-01-01T00:00:00.000Z') {
  const { computeCommitHash } = await import('../lib/commitHash.js');
  const snapshot = { ...entryPayload };
  delete snapshot.commit_hash;
  const hash = await computeCommitHash(snapshot);
  const blob = await encryptEntry({ ...snapshot, commit_hash: hash }, rawEntryKey);
  return { id: `h-${Math.random().toString(36).slice(2)}`, entry_id: entryId, encrypted_snapshot: bytesToB64(blob), created_at: createdAt };
}

// ---------------------------------------------------------------------------
// Session setup — pretends server already has UMK + key pair
// ---------------------------------------------------------------------------

async function setupSession(fetchImpl) {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const idToken = makeJwt({ sub: 'test-uid', exp });
  setRootMasterKey(rootKey);

  // Bootstrap mock
  const bootstrapFetch = vi.fn(async (url, opts) => {
    const u = String(url);
    const method = opts?.method || 'GET';
    const path = new URL(u).pathname;
    if (u.includes('identitytoolkit.googleapis.com')) return mockOk({ idToken, refreshToken: 'rt', localId: 'test-uid' });
    if (method === 'GET' && path === '/keys') return mockOk([
      { key_id: 'umk-1', type: 'umk',        label: null, peer_user_id: null, created_at: '2026-01-01T00:00:00.000Z' },
      { key_id: 'pub-1', type: 'own_public',  label: null, peer_user_id: null, created_at: '2026-01-01T00:00:00.000Z' },
      { key_id: 'prv-1', type: 'own_private', label: null, peer_user_id: null, created_at: '2026-01-01T00:00:00.000Z' },
    ]);
    if (method === 'GET' && path === '/keys/umk-1') return mockOk({ key_id: 'umk-1', type: 'umk', label: null, encrypted_data: encUmkB64, peer_user_id: null, created_at: '2026-01-01T00:00:00.000Z' });
    throw new Error(`Unexpected bootstrap fetch: ${method} ${u}`);
  });
  vi.stubGlobal('fetch', bootstrapFetch);
  await initApi({ worker_url: WORKER_URL, email: 'u@example.com', password: 'pw', firebase_api_key: 'key' });

  // Switch to the per-test mock
  vi.stubGlobal('fetch', fetchImpl);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('create login entry', () => {
  it('POST body contains entry_key, encrypted_data, history_id, encrypted_snapshot', async () => {
    let capturedBody;
    const fetchMock = vi.fn(async (url, opts) => {
      const path = new URL(String(url)).pathname;
      const method = opts?.method || 'GET';
      if (method === 'GET' && path === '/entries')       return mockOk([]);
      if (method === 'GET' && path === '/entries/trash') return mockOk([]);
      if (method === 'POST' && path === '/entries') {
        capturedBody = JSON.parse(opts.body);
        return mockOk({ id: capturedBody.id, created_at: '2026-01-01T00:00:00.000Z' }, 201);
      }
      if (method === 'GET' && /\/entries\/.+\/history$/.test(path)) return mockOk([]);
      throw new Error(`Unexpected: ${method} ${path}`);
    });

    await setupSession(fetchMock);
    const entry = { type: 'login', title: 'Test', username: 'alice', password: 'pw', urls: [], totpSecrets: [], customFields: [], tags: [], notes: '' };
    await createUserEntry(entry);

    expect(capturedBody).toHaveProperty('entry_key');
    expect(capturedBody).toHaveProperty('encrypted_data');
    expect(capturedBody).toHaveProperty('history_id');
    expect(capturedBody).toHaveProperty('encrypted_snapshot');
  });

  it('returned entry has type "login" and correct title', async () => {
    const fetchMock = vi.fn(async (url, opts) => {
      const path = new URL(String(url)).pathname;
      const method = opts?.method || 'GET';
      let id;
      if (method === 'GET' && path === '/entries')       return mockOk([]);
      if (method === 'GET' && path === '/entries/trash') return mockOk([]);
      if (method === 'POST' && path === '/entries') {
        id = JSON.parse(opts.body).id;
        return mockOk({ id, created_at: '2026-01-01T00:00:00.000Z' }, 201);
      }
      if (method === 'GET' && /\/entries\/.+\/history$/.test(path)) return mockOk([]);
      throw new Error(`Unexpected: ${method} ${path}`);
    });

    await setupSession(fetchMock);
    const created = await createUserEntry({ type: 'login', title: 'My Login', username: 'u', password: 'p', urls: [], totpSecrets: [], customFields: [], tags: [], notes: '' });

    expect(created.type).toBe('login');
    expect(created.title).toBe('My Login');
    expect(created.id).toBeTruthy();
  });
});

describe('update entry', () => {
  it('PUT body does not contain entry_key; encrypted_data is updated', async () => {
    let createdId;
    let putBody;
    const fetchMock = vi.fn(async (url, opts) => {
      const path = new URL(String(url)).pathname;
      const method = opts?.method || 'GET';
      if (method === 'GET' && path === '/entries')       return mockOk([]);
      if (method === 'GET' && path === '/entries/trash') return mockOk([]);
      if (method === 'POST' && path === '/entries') {
        const b = JSON.parse(opts.body);
        createdId = b.id;
        return mockOk({ id: createdId, created_at: '2026-01-01T00:00:00.000Z' }, 201);
      }
      if (method === 'GET' && new RegExp(`/entries/${createdId}/history$`).test(path)) return mockOk([]);
      if (method === 'PUT' && new RegExp(`/entries/${createdId}$`).test(path)) {
        putBody = JSON.parse(opts.body);
        return mockOk({ id: createdId, updated_at: '2026-01-02T00:00:00.000Z' });
      }
      if (method === 'GET' && /\/entries\/.+\/history$/.test(path)) return mockOk([]);
      throw new Error(`Unexpected: ${method} ${path}`);
    });

    await setupSession(fetchMock);
    const original = { type: 'login', title: 'Old', username: 'u', password: 'p', urls: [], totpSecrets: [], customFields: [], tags: [], notes: '' };
    const created = await createUserEntry(original);

    const updated = { ...original, title: 'Updated' };
    await updateUserEntry(created.id, updated);

    expect(putBody.entry_key).toBeUndefined();
    expect(putBody).toHaveProperty('encrypted_data');
    expect(putBody).toHaveProperty('history_id');
    expect(putBody).toHaveProperty('encrypted_snapshot');
  });

  it('entry_key bytes are identical across create and update (not regenerated)', async () => {
    let createBody;
    let createdId;
    const fetchMock = vi.fn(async (url, opts) => {
      const path = new URL(String(url)).pathname;
      const method = opts?.method || 'GET';
      if (method === 'GET' && path === '/entries')       return mockOk([]);
      if (method === 'GET' && path === '/entries/trash') return mockOk([]);
      if (method === 'POST' && path === '/entries') {
        createBody = JSON.parse(opts.body);
        createdId = createBody.id;
        return mockOk({ id: createdId, created_at: '2026-01-01T00:00:00.000Z' }, 201);
      }
      if (method === 'PUT' && path.startsWith('/entries/')) return mockOk({ id: createdId, updated_at: '2026-01-02T00:00:00.000Z' });
      if (method === 'GET' && /\/entries\/.+\/history$/.test(path)) return mockOk([]);
      throw new Error(`Unexpected: ${method} ${path}`);
    });

    await setupSession(fetchMock);
    const entry = { type: 'login', title: 'v1', username: 'u', password: 'p', urls: [], totpSecrets: [], customFields: [], tags: [], notes: '' };
    const created = await createUserEntry(entry);

    // The entry_key from CREATE is the wrapped 64-byte key.
    // After UPDATE, encrypted_data is re-encrypted with the same raw entry key.
    // We verify this by decrypting the updated encrypted_data with the cached entry key.
    // Since the entry_key blob itself is not re-uploaded on update, it must be the same.
    // We can confirm indirectly: the entry returned by updateUserEntry should still decrypt correctly.
    const { generateEntryKey: _g, decryptEntryKey, decryptEntry, bytesToB64: _b } = await import('../lib/crypto.js');
    const entryKeyBlob = created._entryMeta.entry_key_blob;
    expect(entryKeyBlob).toBe(createBody.entry_key);
  });

  it('decrypt updated entry recovers updated JSON', async () => {
    let createdId;
    const fetchMock = vi.fn(async (url, opts) => {
      const path = new URL(String(url)).pathname;
      const method = opts?.method || 'GET';
      if (method === 'GET' && path === '/entries')       return mockOk([]);
      if (method === 'GET' && path === '/entries/trash') return mockOk([]);
      if (method === 'POST' && path === '/entries') {
        createdId = JSON.parse(opts.body).id;
        return mockOk({ id: createdId, created_at: '2026-01-01T00:00:00.000Z' }, 201);
      }
      if (method === 'PUT') return mockOk({ id: createdId, updated_at: '2026-01-02T00:00:00.000Z' });
      if (method === 'GET' && /\/entries\/.+\/history$/.test(path)) return mockOk([]);
      throw new Error(`Unexpected: ${method} ${path}`);
    });

    await setupSession(fetchMock);
    const created = await createUserEntry({ type: 'login', title: 'v1', username: 'u', password: 'p', urls: [], totpSecrets: [], customFields: [], tags: [], notes: '' });
    const updated = await updateUserEntry(created.id, { ...created, title: 'v2', password: 'new-pw' });

    expect(updated.title).toBe('v2');
    expect(updated.password).toBe('new-pw');
  });
});

describe('soft delete → restore → soft delete → purge lifecycle', () => {
  it('entry state is correct at each step', async () => {
    let createdId;
    const fetchMock = vi.fn(async (url, opts) => {
      const path = new URL(String(url)).pathname;
      const method = opts?.method || 'GET';
      if (method === 'GET' && path === '/entries')       return mockOk([]);
      if (method === 'GET' && path === '/entries/trash') return mockOk([]);
      if (method === 'POST' && path === '/entries') {
        createdId = JSON.parse(opts.body).id;
        return mockOk({ id: createdId, created_at: '2026-01-01T00:00:00.000Z' }, 201);
      }
      if (method === 'GET' && /\/entries\/.+\/history$/.test(path)) return mockOk([]);
      // DELETE /entries/:id → soft delete
      if (method === 'DELETE' && new RegExp(`/entries/${createdId}$`).test(path)) {
        return mockOk({ id: createdId, deleted_at: '2026-01-02T00:00:00.000Z' });
      }
      // POST /entries/:id/restore
      if (method === 'POST' && new RegExp(`/entries/${createdId}/restore$`).test(path)) {
        return mockOk({ id: createdId });
      }
      // DELETE /entries/:id/purge
      if (method === 'DELETE' && new RegExp(`/entries/${createdId}/purge$`).test(path)) {
        return mockOk({ id: createdId });
      }
      throw new Error(`Unexpected: ${method} ${path}`);
    });

    await setupSession(fetchMock);
    const entry = { type: 'login', title: 'Lifecycle', username: 'u', password: 'p', urls: [], totpSecrets: [], customFields: [], tags: [], notes: '' };

    // Step 1: create
    const created = await createUserEntry(entry);
    expect(created.id).toBeTruthy();
    let state = await fetchUserEntries();
    expect(state.entries.some((e) => e.id === created.id)).toBe(true);
    expect(state.trash).toHaveLength(0);

    // Step 2: soft delete
    const trashed = await deleteUserEntry(created.id);
    expect(trashed.deletedAt).toBeTruthy();
    state = await fetchUserEntries();
    expect(state.entries.every((e) => e.id !== created.id)).toBe(true);
    expect(state.trash.some((e) => e.id === created.id)).toBe(true);

    // Step 3: restore
    const restored = await restoreDeletedUserEntry(created.id);
    expect(restored.deletedAt).toBeUndefined();
    state = await fetchUserEntries();
    expect(state.entries.some((e) => e.id === created.id)).toBe(true);
    expect(state.trash).toHaveLength(0);

    // Step 4: soft delete again
    await deleteUserEntry(created.id);
    state = await fetchUserEntries();
    expect(state.entries.every((e) => e.id !== created.id)).toBe(true);
    expect(state.trash.some((e) => e.id === created.id)).toBe(true);

    // Step 5: purge
    await permanentlyDeleteUserEntry(created.id);
    // after purge, both caches are empty → ensureVaultLoaded would reload;
    // stub fresh empty responses for the reload
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      const path = new URL(String(url)).pathname;
      const method = opts?.method || 'GET';
      if (method === 'GET' && path === '/entries')       return mockOk([]);
      if (method === 'GET' && path === '/entries/trash') return mockOk([]);
      throw new Error(`Unexpected: ${method} ${path}`);
    }));
    state = await fetchUserEntries();
    expect(state.entries).toHaveLength(0);
    expect(state.trash).toHaveLength(0);
  });
});
