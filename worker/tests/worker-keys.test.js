import { describe, expect, it, vi } from 'vitest';
import { createFetchHandler } from '../src/index.js';

const USER_ID = 'yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy';
const GOOD_ID = '3rd65irghj1jkh68ybpcqq4jprhs5cip9rpaytwgb79tssdddugo';
const BLOB_132 = btoa(String.fromCharCode(...new Uint8Array(132).fill(1)));

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

describe('worker keys routes', () => {
  it('GET /keys returns metadata only', async () => {
    const { handler } = makeHandler({
      query: vi.fn(async () => [{ key_id: GOOD_ID, type: 'umk', label: null, peer_user_id: null, created_at: 't' }]),
    });
    const res = await handler(req('/keys'), { FIREBASE_PROJECT_ID: 'proj' });
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data[0].encrypted_data).toBeUndefined();
  });

  it('POST /keys inserts and returns 201 with key_id and created_at', async () => {
    const { handler } = makeHandler();
    const res = await handler(req('/keys', 'POST', {
      key_id: GOOD_ID,
      type: 'umk',
      encrypted_data: BLOB_132,
    }), { FIREBASE_PROJECT_ID: 'proj' });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.key_id).toBe(GOOD_ID);
    expect(data.created_at).toBeTruthy();
  });

  it('POST /keys validates type and peer_user_id constraints', async () => {
    const { handler } = makeHandler();
    const invalidType = await handler(req('/keys', 'POST', {
      key_id: GOOD_ID,
      type: 'unknown',
      encrypted_data: BLOB_132,
    }), { FIREBASE_PROJECT_ID: 'proj' });
    expect(invalidType.status).toBe(400);

    const selfPeer = await handler(req('/keys', 'POST', {
      key_id: GOOD_ID,
      type: 'peer_public',
      peer_user_id: USER_ID,
      encrypted_data: BLOB_132,
    }), { FIREBASE_PROJECT_ID: 'proj' });
    expect(selfPeer.status).toBe(400);
  });

  it('GET /keys/:key_id returns full row and 404 for cross-user lookup', async () => {
    const queryMock = vi.fn()
      .mockResolvedValueOnce([{ key_id: GOOD_ID, type: 'umk', encrypted_data: BLOB_132 }])
      .mockResolvedValueOnce([]);
    const { handler } = makeHandler({ query: queryMock });

    const ok = await handler(req(`/keys/${GOOD_ID}`), { FIREBASE_PROJECT_ID: 'proj' });
    expect(ok.status).toBe(200);
    expect((await ok.json()).encrypted_data).toBeDefined();

    const notFound = await handler(req(`/keys/${GOOD_ID}`), { FIREBASE_PROJECT_ID: 'proj' });
    expect(notFound.status).toBe(404);
  });

  it('DELETE /keys/:key_id deletes owned row', async () => {
    const { handler } = makeHandler({ query: vi.fn().mockResolvedValueOnce([{ key_id: GOOD_ID }]) });
    const res = await handler(req(`/keys/${GOOD_ID}`, 'DELETE'), { FIREBASE_PROJECT_ID: 'proj' });
    expect(res.status).toBe(200);
  });

  it('GET /users/:user_id/public-key returns key, 404 otherwise, and requires auth', async () => {
    const queryMock = vi.fn()
      .mockResolvedValueOnce([{ encrypted_data: BLOB_132 }])
      .mockResolvedValueOnce([]);
    const { handler } = makeHandler({ query: queryMock });

    const ok = await handler(req(`/users/${GOOD_ID}/public-key`), { FIREBASE_PROJECT_ID: 'proj' });
    expect(ok.status).toBe(200);
    expect((await ok.json()).public_key).toBe(BLOB_132);

    const missing = await handler(req(`/users/${GOOD_ID}/public-key`), { FIREBASE_PROJECT_ID: 'proj' });
    expect(missing.status).toBe(404);

    const noAuth = await handler(new Request(`https://worker.test/users/${GOOD_ID}/public-key`), { FIREBASE_PROJECT_ID: 'proj' });
    expect(noAuth.status).toBe(401);
  });
});
