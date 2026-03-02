import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import leancrypto from '../../leancrypto/leancrypto.js';
import {
  initApi,
  setRootMasterKey,
  clearUserMasterKey,
  getEntries,
  getTrashEntries,
  createEntry,
  updateEntry,
  deleteEntry,
  restoreEntry,
  purgeEntry,
  getHistory,
  getKeys,
  addKey,
  getKey,
  deleteKey,
} from '../lib/api.js';
import { generateEntryKey, encryptUMK, bytesToB64 } from '../lib/crypto.js';

const WORKER_URL = 'https://worker.example.workers.dev';

// JWT with base64url-encoded payload (no real signature needed — only the payload is parsed)
function makeJwt(payload) {
  const b64 = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return `header.${b64}.sig`;
}

function mockOk(body, status = 200) {
  return { ok: true, status, json: async () => body };
}

function mockErr(body, status) {
  return { ok: false, status, json: async () => body };
}

// Pre-generated crypto material (requires leancrypto — set up in beforeAll)
let rootKey;
let encUmkB64;

beforeAll(async () => {
  globalThis.leancrypto = leancrypto;
  rootKey = crypto.getRandomValues(new Uint8Array(256));
  const umk = generateEntryKey();
  encUmkB64 = bytesToB64(await encryptUMK(umk, rootKey));
});

afterEach(() => {
  clearUserMasterKey();
  vi.unstubAllGlobals();
});

// Sets up a session via initApi with mocked bootstrap responses.
// After this returns, session is ready and fetch is unset (caller must set it for the test).
async function setupSession() {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const idToken = makeJwt({ sub: 'test-uid', exp });

  setRootMasterKey(rootKey);

  vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
    const u = String(url);
    const method = opts?.method || 'GET';
    const path = new URL(u).pathname;

    if (u.includes('identitytoolkit.googleapis.com')) {
      return mockOk({ idToken, refreshToken: 'rt', localId: 'test-uid' });
    }
    // GET /keys — return all three key types so no bootstrapping writes are triggered
    if (method === 'GET' && path === '/keys') {
      return mockOk([
        { key_id: 'umk-1', type: 'umk',       label: null, peer_user_id: null, created_at: '2026-01-01T00:00:00.000Z' },
        { key_id: 'pub-1', type: 'own_public', label: null, peer_user_id: null, created_at: '2026-01-01T00:00:00.000Z' },
        { key_id: 'prv-1', type: 'own_private',label: null, peer_user_id: null, created_at: '2026-01-01T00:00:00.000Z' },
      ]);
    }
    // GET /keys/umk-1 — return the encrypted UMK blob
    if (method === 'GET' && path === '/keys/umk-1') {
      return mockOk({ key_id: 'umk-1', type: 'umk', label: null, encrypted_data: encUmkB64, peer_user_id: null, created_at: '2026-01-01T00:00:00.000Z' });
    }
    throw new Error(`Unexpected bootstrap fetch: ${method} ${u}`);
  }));

  await initApi({ worker_url: WORKER_URL, email: 'u@example.com', password: 'pw', firebase_api_key: 'key' });
}

// Capture the most recent fetch call's request details.
function lastCall(mock) {
  const calls = mock.mock.calls;
  const [url, opts] = calls[calls.length - 1];
  const headers = opts?.headers instanceof Headers ? opts.headers : new Headers(opts?.headers || {});
  const body = opts?.body ? JSON.parse(opts.body) : undefined;
  return { url: String(url), method: opts?.method || 'GET', headers, body };
}

// ---------------------------------------------------------------------------
// GET /entries
// ---------------------------------------------------------------------------

describe('getEntries', () => {
  it('sends GET /entries with Bearer Authorization header', async () => {
    await setupSession();
    const mock = vi.fn(async () => mockOk([]));
    vi.stubGlobal('fetch', mock);

    await getEntries();

    const { url, method, headers } = lastCall(mock);
    expect(url).toContain('/entries');
    expect(method).toBe('GET');
    expect(headers.get('Authorization')).toMatch(/^Bearer /);
  });

  it('returns an array', async () => {
    await setupSession();
    vi.stubGlobal('fetch', vi.fn(async () => mockOk([{ id: 'e1' }])));
    expect(Array.isArray(await getEntries())).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// POST /entries
// ---------------------------------------------------------------------------

describe('createEntry', () => {
  it('sends POST /entries with entry_key, encrypted_data, history_id, encrypted_snapshot', async () => {
    await setupSession();
    const mock = vi.fn(async () => mockOk({ id: 'new-id', created_at: '2026-01-01T00:00:00.000Z' }, 201));
    vi.stubGlobal('fetch', mock);

    await createEntry({
      id: 'new-id',
      entry_key: 'ek',
      encrypted_data: 'ed',
      history_id: 'hi',
      encrypted_snapshot: 'es',
    });

    const { url, method, body } = lastCall(mock);
    expect(new URL(url).pathname).toBe('/entries');
    expect(method).toBe('POST');
    expect(body).toMatchObject({ entry_key: 'ek', encrypted_data: 'ed', history_id: 'hi', encrypted_snapshot: 'es' });
  });

  it('returns {id, created_at}', async () => {
    await setupSession();
    vi.stubGlobal('fetch', vi.fn(async () => mockOk({ id: 'x', created_at: '2026-01-01T00:00:00.000Z' }, 201)));
    const result = await createEntry({ id: 'x', entry_key: 'ek', encrypted_data: 'ed', history_id: 'hi', encrypted_snapshot: 'es' });
    expect(result).toMatchObject({ id: 'x', created_at: expect.any(String) });
  });
});

// ---------------------------------------------------------------------------
// PUT /entries/:id
// ---------------------------------------------------------------------------

describe('updateEntry', () => {
  it('sends PUT /entries/:id without entry_key in body', async () => {
    await setupSession();
    const mock = vi.fn(async () => mockOk({ id: 'e1', updated_at: '2026-01-02T00:00:00.000Z' }));
    vi.stubGlobal('fetch', mock);

    await updateEntry('e1', { encrypted_data: 'ed2', history_id: 'hi2', encrypted_snapshot: 'es2' });

    const { url, method, body } = lastCall(mock);
    expect(new URL(url).pathname).toBe('/entries/e1');
    expect(method).toBe('PUT');
    expect(body.entry_key).toBeUndefined();
    expect(body).toMatchObject({ encrypted_data: 'ed2', history_id: 'hi2', encrypted_snapshot: 'es2' });
  });

  it('returns {id, updated_at}', async () => {
    await setupSession();
    vi.stubGlobal('fetch', vi.fn(async () => mockOk({ id: 'e1', updated_at: '2026-01-02T00:00:00.000Z' })));
    const result = await updateEntry('e1', { encrypted_data: 'ed2', history_id: 'hi2', encrypted_snapshot: 'es2' });
    expect(result).toMatchObject({ id: 'e1', updated_at: expect.any(String) });
  });
});

// ---------------------------------------------------------------------------
// DELETE /entries/:id
// ---------------------------------------------------------------------------

describe('deleteEntry', () => {
  it('sends DELETE /entries/:id', async () => {
    await setupSession();
    const mock = vi.fn(async () => mockOk({ id: 'e1', deleted_at: '2026-01-02T00:00:00.000Z' }));
    vi.stubGlobal('fetch', mock);

    await deleteEntry('e1');

    const { url, method } = lastCall(mock);
    expect(new URL(url).pathname).toBe('/entries/e1');
    expect(method).toBe('DELETE');
  });
});

// ---------------------------------------------------------------------------
// POST /entries/:id/restore
// ---------------------------------------------------------------------------

describe('restoreEntry', () => {
  it('sends POST /entries/:id/restore', async () => {
    await setupSession();
    const mock = vi.fn(async () => mockOk({ id: 'e1' }));
    vi.stubGlobal('fetch', mock);

    await restoreEntry('e1');

    const { url, method } = lastCall(mock);
    expect(new URL(url).pathname).toBe('/entries/e1/restore');
    expect(method).toBe('POST');
  });
});

// ---------------------------------------------------------------------------
// DELETE /entries/:id/purge
// ---------------------------------------------------------------------------

describe('purgeEntry', () => {
  it('sends DELETE /entries/:id/purge', async () => {
    await setupSession();
    const mock = vi.fn(async () => mockOk({ id: 'e1' }));
    vi.stubGlobal('fetch', mock);

    await purgeEntry('e1');

    const { url, method } = lastCall(mock);
    expect(new URL(url).pathname).toBe('/entries/e1/purge');
    expect(method).toBe('DELETE');
  });
});

// ---------------------------------------------------------------------------
// GET /entries/:id/history
// ---------------------------------------------------------------------------

describe('getHistory', () => {
  it('sends GET /entries/:id/history and returns array', async () => {
    await setupSession();
    const mock = vi.fn(async () => mockOk([{ id: 'h1', entry_id: 'e1', encrypted_snapshot: 'x', created_at: '2026-01-01T00:00:00.000Z' }]));
    vi.stubGlobal('fetch', mock);

    const result = await getHistory('e1');

    const { url, method } = lastCall(mock);
    expect(new URL(url).pathname).toBe('/entries/e1/history');
    expect(method).toBe('GET');
    expect(Array.isArray(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GET /keys
// ---------------------------------------------------------------------------

describe('getKeys', () => {
  it('sends GET /keys and returns metadata array', async () => {
    await setupSession();
    const mock = vi.fn(async () => mockOk([{ key_id: 'k1', type: 'umk', label: null, peer_user_id: null, created_at: '2026-01-01T00:00:00.000Z' }]));
    vi.stubGlobal('fetch', mock);

    const result = await getKeys();

    const { url, method } = lastCall(mock);
    expect(new URL(url).pathname).toBe('/keys');
    expect(method).toBe('GET');
    expect(Array.isArray(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// POST /keys
// ---------------------------------------------------------------------------

describe('addKey', () => {
  it('sends POST /keys and returns {key_id, created_at}', async () => {
    await setupSession();
    const mock = vi.fn(async () => mockOk({ key_id: 'k2', created_at: '2026-01-01T00:00:00.000Z' }, 201));
    vi.stubGlobal('fetch', mock);

    const result = await addKey({ key_id: 'k2', type: 'emergency', label: null, encrypted_data: 'ed', peer_user_id: null });

    const { url, method, body } = lastCall(mock);
    expect(new URL(url).pathname).toBe('/keys');
    expect(method).toBe('POST');
    expect(body.key_id).toBe('k2');
    expect(result).toMatchObject({ key_id: 'k2', created_at: expect.any(String) });
  });
});

// ---------------------------------------------------------------------------
// GET /keys/:key_id
// ---------------------------------------------------------------------------

describe('getKey', () => {
  it('sends GET /keys/:key_id and returns full record', async () => {
    await setupSession();
    const full = { key_id: 'k1', type: 'umk', label: null, encrypted_data: 'blob', peer_user_id: null, created_at: '2026-01-01T00:00:00.000Z' };
    const mock = vi.fn(async () => mockOk(full));
    vi.stubGlobal('fetch', mock);

    const result = await getKey('k1');

    const { url, method } = lastCall(mock);
    expect(new URL(url).pathname).toBe('/keys/k1');
    expect(method).toBe('GET');
    expect(result.encrypted_data).toBe('blob');
  });
});

// ---------------------------------------------------------------------------
// DELETE /keys/:key_id
// ---------------------------------------------------------------------------

describe('deleteKey', () => {
  it('sends DELETE /keys/:key_id', async () => {
    await setupSession();
    const mock = vi.fn(async () => mockOk({ key_id: 'k1' }));
    vi.stubGlobal('fetch', mock);

    await deleteKey('k1');

    const { url, method } = lastCall(mock);
    expect(new URL(url).pathname).toBe('/keys/k1');
    expect(method).toBe('DELETE');
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('error handling', () => {
  it('401 response throws with code AUTH_ERROR', async () => {
    await setupSession();
    vi.stubGlobal('fetch', vi.fn(async () => mockErr({ error: 'Unauthorized' }, 401)));

    const err = await getEntries().catch((e) => e);
    expect(err.code).toBe('AUTH_ERROR');
  });

  it('400 response throws with code VALIDATION_ERROR', async () => {
    await setupSession();
    vi.stubGlobal('fetch', vi.fn(async () => mockErr({ error: 'Bad request' }, 400)));

    const err = await getEntries().catch((e) => e);
    expect(err.code).toBe('VALIDATION_ERROR');
  });

  it('401 is thrown for all major entry functions', async () => {
    const fns = [
      () => getEntries(),
      () => getTrashEntries(),
      () => createEntry({ id: 'x', entry_key: 'ek', encrypted_data: 'ed', history_id: 'hi', encrypted_snapshot: 'es' }),
      () => updateEntry('x', { encrypted_data: 'ed', history_id: 'hi', encrypted_snapshot: 'es' }),
      () => deleteEntry('x'),
      () => restoreEntry('x'),
      () => purgeEntry('x'),
      () => getHistory('x'),
    ];
    for (const fn of fns) {
      await setupSession();
      vi.stubGlobal('fetch', vi.fn(async () => mockErr({ error: 'Unauthorized' }, 401)));
      const err = await fn().catch((e) => e);
      expect(err.code).toBe('AUTH_ERROR');
      clearUserMasterKey();
      vi.unstubAllGlobals();
    }
  });
});
