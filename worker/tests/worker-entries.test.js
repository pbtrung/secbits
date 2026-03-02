import { describe, expect, it, vi } from 'vitest';
import { createFetchHandler } from '../src/index.js';

const USER_ID = 'yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy';
const GOOD_ID = '3rd65irghj1jkh68ybpcqq4jprhs5cip9rpaytwgb79tssdddugo';
const BLOB_132 = btoa(String.fromCharCode(...new Uint8Array(132).fill(1)));
const BLOB_196 = btoa(String.fromCharCode(...new Uint8Array(196).fill(2)));

function makeHandler(overrides = {}) {
  const deps = {
    verifyFirebaseToken: vi.fn(async () => ({ sub: 'firebase-uid' })),
    deriveUserId: vi.fn(() => USER_ID),
    query: vi.fn(async () => []),
    execute: vi.fn(async () => ({ rows_affected: 1 })),
    executeBatch: vi.fn(async () => []),
    ...overrides,
  };
  return { deps, handler: createFetchHandler(deps) };
}

function req(path, method = 'GET', body) {
  return new Request(`https://worker.test${path}`, {
    method,
    headers: {
      Authorization: 'Bearer token',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe('worker entries routes', () => {
  it('GET /entries for new user returns []', async () => {
    const { handler } = makeHandler({ query: vi.fn(async () => []) });
    const res = await handler(req('/entries'), { FIREBASE_PROJECT_ID: 'proj' });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual([]);
  });

  it('POST /entries inserts entry + history and returns 201', async () => {
    const queryMock = vi.fn()
      .mockResolvedValueOnce([]); // duplicate check
    const { handler, deps } = makeHandler({ query: queryMock });
    const res = await handler(req('/entries', 'POST', {
      id: GOOD_ID,
      entry_key: BLOB_196,
      encrypted_data: BLOB_132,
      history_id: GOOD_ID,
      encrypted_snapshot: BLOB_132,
    }), { FIREBASE_PROJECT_ID: 'proj' });

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.id).toBe(GOOD_ID);
    expect(deps.executeBatch).toHaveBeenCalled();
  });

  it('POST /entries rejects invalid ids and short blobs', async () => {
    const { handler } = makeHandler();
    const bad = await handler(req('/entries', 'POST', {
      id: 'bad',
      entry_key: 'nope',
      encrypted_data: 'x',
      history_id: 'bad',
      encrypted_snapshot: 'x',
    }), { FIREBASE_PROJECT_ID: 'proj' });
    expect(bad.status).toBe(400);
  });

  it('PUT /entries/:id applies 20-history cap', async () => {
    const queryMock = vi.fn()
      .mockResolvedValueOnce([{ id: GOOD_ID }]) // owned entry
      .mockResolvedValueOnce([{ c: 20 }]); // history count
    const { handler, deps } = makeHandler({ query: queryMock });

    const res = await handler(req(`/entries/${GOOD_ID}`, 'PUT', {
      encrypted_data: BLOB_132,
      history_id: GOOD_ID,
      encrypted_snapshot: BLOB_132,
    }), { FIREBASE_PROJECT_ID: 'proj' });
    expect(res.status).toBe(200);
    const [[, statements]] = deps.executeBatch.mock.calls;
    const hasPrune = statements.some((s) => s.sql.includes('DELETE FROM entry_history WHERE id = (SELECT id'));
    expect(hasPrune).toBe(true);
  });

  it('ownership checks return 404 for missing entry on write', async () => {
    const { handler } = makeHandler({ query: vi.fn().mockResolvedValueOnce([]) });
    const res = await handler(req(`/entries/${GOOD_ID}`, 'DELETE'), { FIREBASE_PROJECT_ID: 'proj' });
    expect(res.status).toBe(404);
  });

  it('supports trash lifecycle routes', async () => {
    const queryMock = vi.fn()
      .mockResolvedValueOnce([{ id: GOOD_ID }]) // delete
      .mockResolvedValueOnce([{ id: GOOD_ID }]) // restore
      .mockResolvedValueOnce([{ id: GOOD_ID }]); // purge
    const { handler } = makeHandler({ query: queryMock });

    expect((await handler(req(`/entries/${GOOD_ID}`, 'DELETE'), { FIREBASE_PROJECT_ID: 'proj' })).status).toBe(200);
    expect((await handler(req(`/entries/${GOOD_ID}/restore`, 'POST'), { FIREBASE_PROJECT_ID: 'proj' })).status).toBe(200);
    expect((await handler(req(`/entries/${GOOD_ID}/purge`, 'DELETE'), { FIREBASE_PROJECT_ID: 'proj' })).status).toBe(200);
  });

  it('PUT /entries/:id/entry-key rewrites wrapped entry key', async () => {
    const queryMock = vi.fn().mockResolvedValueOnce([{ id: GOOD_ID }]);
    const { handler } = makeHandler({ query: queryMock });
    const res = await handler(req(`/entries/${GOOD_ID}/entry-key`, 'PUT', {
      entry_key: BLOB_196,
    }), { FIREBASE_PROJECT_ID: 'proj' });
    expect(res.status).toBe(200);
  });

  it('POST /entries returns 409 on duplicate id', async () => {
    const { handler } = makeHandler({
      query: vi.fn().mockResolvedValueOnce([{ id: GOOD_ID }]), // duplicate found
    });
    const res = await handler(req('/entries', 'POST', {
      id: GOOD_ID,
      entry_key: BLOB_196,
      encrypted_data: BLOB_132,
      history_id: GOOD_ID,
      encrypted_snapshot: BLOB_132,
    }), { FIREBASE_PROJECT_ID: 'proj' });
    expect(res.status).toBe(409);
  });

  it('GET /entries only returns rows for the authenticated user', async () => {
    const ROWS = [{ id: GOOD_ID, entry_key: BLOB_196, encrypted_data: BLOB_132, created_at: 't', updated_at: 't' }];
    let capturedSql, capturedParams;
    const { handler } = makeHandler({
      query: vi.fn(async (env, sql, params) => {
        capturedSql = sql;
        capturedParams = params;
        return ROWS;
      }),
    });
    const res = await handler(req('/entries'), { FIREBASE_PROJECT_ID: 'proj' });
    expect(res.status).toBe(200);
    // user_id must appear in the query params (not just the SQL string)
    expect(capturedParams).toContain(USER_ID);
  });

  it('GET /entries/:id/history returns rows ordered created_at DESC', async () => {
    const historyRows = [
      { id: GOOD_ID, entry_id: GOOD_ID, encrypted_snapshot: BLOB_132, created_at: '2025-01-02T00:00:00Z' },
      { id: GOOD_ID, entry_id: GOOD_ID, encrypted_snapshot: BLOB_132, created_at: '2025-01-01T00:00:00Z' },
    ];
    const queryMock = vi.fn()
      .mockResolvedValueOnce([{ id: GOOD_ID }]) // ownership check
      .mockResolvedValueOnce(historyRows);       // history rows
    let capturedSql;
    const { handler } = makeHandler({
      query: vi.fn(async (env, sql, params) => {
        capturedSql = sql;
        return queryMock(env, sql, params);
      }),
    });
    const res = await handler(req(`/entries/${GOOD_ID}/history`), { FIREBASE_PROJECT_ID: 'proj' });
    expect(res.status).toBe(200);
    expect(capturedSql).toMatch(/ORDER BY created_at DESC/i);
  });

  it('rejects malformed base64 for encrypted_data, encrypted_snapshot, entry_key with 400', async () => {
    const { handler } = makeHandler();
    const res = await handler(req('/entries', 'POST', {
      id: GOOD_ID,
      history_id: GOOD_ID,
      entry_key: '!!!notbase64!!!',
      encrypted_data: '!!!notbase64!!!',
      encrypted_snapshot: '!!!notbase64!!!',
    }), { FIREBASE_PROJECT_ID: 'proj' });
    expect(res.status).toBe(400);
  });

  it('rejects missing bearer token with 401', async () => {
    const { handler } = makeHandler();
    const res = await handler(new Request('https://worker.test/entries'), { FIREBASE_PROJECT_ID: 'proj' });
    expect(res.status).toBe(401);
  });
});
