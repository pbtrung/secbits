import { deriveUserId, verifyFirebaseToken } from './firebase';
import { execute, executeBatch, query } from './rqlite';
import { isValidZBase32Id } from './zbase32';

const KEY_TYPES = new Set(['umk', 'emergency', 'own_public', 'own_private', 'peer_public']);
const BLOB_MIN_LEN = 132;
const ENTRY_KEY_MIN_LEN = 196;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function corsHeaders(origin = '*') {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(data, status = 200, origin = '*') {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(origin),
    },
  });
}

function nowIso() {
  return new Date().toISOString();
}

function requireZbase32Id(value, field) {
  if (!isValidZBase32Id(value)) throw new HttpError(400, `Invalid ${field}`);
}

function decodeBase64(value, field) {
  try {
    const text = atob(String(value || ''));
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
    return out;
  } catch {
    throw new HttpError(400, `Invalid ${field}`);
  }
}

function requireBlobBase64(value, field, minLen = BLOB_MIN_LEN) {
  const bytes = decodeBase64(value, field);
  if (bytes.length < minLen) throw new HttpError(400, `Invalid ${field}`);
}

async function parseJsonBody(request) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') throw new HttpError(400, 'Invalid JSON body');
  return body;
}

async function requireAuthContext(request, env, deps) {
  const header = request.headers.get('Authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new HttpError(401, 'Missing bearer token');

  let token;
  try {
    token = await deps.verifyFirebaseToken(match[1], env.FIREBASE_PROJECT_ID);
  } catch {
    throw new HttpError(401, 'Invalid bearer token');
  }

  const userId = deps.deriveUserId(token.sub);
  await deps.execute(
    env,
    'INSERT OR IGNORE INTO users (user_id, created_at) VALUES (?, ?)',
    [userId, nowIso()],
  );
  return { token, userId };
}

function splitPath(pathname) {
  return pathname.split('/').filter(Boolean);
}

async function getOwnedEntry(env, deps, userId, id) {
  const rows = await deps.query(
    env,
    'SELECT id, entry_key, encrypted_data, created_at, updated_at, deleted_at FROM entries WHERE id = ? AND user_id = ?',
    [id, userId],
  );
  return rows[0] || null;
}

async function getOwnedKey(env, deps, userId, keyId) {
  const rows = await deps.query(
    env,
    'SELECT key_id, type, label, encrypted_data, peer_user_id, created_at FROM key_store WHERE key_id = ? AND user_id = ?',
    [keyId, userId],
  );
  return rows[0] || null;
}

async function runInTransaction(env, deps, statements) {
  if (deps.executeBatch) {
    await deps.executeBatch(env, [
      { sql: 'BEGIN' },
      ...statements,
      { sql: 'COMMIT' },
    ]);
    return;
  }

  await deps.execute(env, 'BEGIN');
  try {
    for (const statement of statements) {
      await deps.execute(env, statement.sql, statement.params || []);
    }
    await deps.execute(env, 'COMMIT');
  } catch (err) {
    try {
      await deps.execute(env, 'ROLLBACK');
    } catch {
      // no-op
    }
    throw err;
  }
}

async function handleEntries(request, env, deps, userId, segments) {
  if (segments.length === 1 && request.method === 'GET') {
    const rows = await deps.query(
      env,
      'SELECT id, entry_key, encrypted_data, created_at, updated_at FROM entries WHERE user_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC',
      [userId],
    );
    return rows;
  }

  if (segments.length === 2 && segments[1] === 'trash' && request.method === 'GET') {
    return deps.query(
      env,
      'SELECT id, entry_key, encrypted_data, created_at, updated_at, deleted_at FROM entries WHERE user_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC',
      [userId],
    );
  }

  if (segments.length === 1 && request.method === 'POST') {
    const body = await parseJsonBody(request);
    requireZbase32Id(body.id, 'id');
    requireZbase32Id(body.history_id, 'history_id');
    requireBlobBase64(body.entry_key, 'entry_key', ENTRY_KEY_MIN_LEN);
    requireBlobBase64(body.encrypted_data, 'encrypted_data', BLOB_MIN_LEN);
    requireBlobBase64(body.encrypted_snapshot, 'encrypted_snapshot', BLOB_MIN_LEN);

    const exists = await getOwnedEntry(env, deps, userId, body.id);
    if (exists) throw new HttpError(409, 'Entry already exists');

    const ts = nowIso();
    await runInTransaction(env, deps, [
      {
        sql: 'INSERT INTO entries (id, user_id, entry_key, encrypted_data, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, NULL)',
        params: [body.id, userId, body.entry_key, body.encrypted_data, ts, ts],
      },
      {
        sql: 'INSERT INTO entry_history (id, entry_id, encrypted_snapshot, created_at) VALUES (?, ?, ?, ?)',
        params: [body.history_id, body.id, body.encrypted_snapshot, ts],
      },
    ]);
    return { id: body.id, created_at: ts, _status: 201 };
  }

  if (segments.length >= 2) {
    const entryId = segments[1];
    requireZbase32Id(entryId, 'id');

    if (segments.length === 3 && segments[2] === 'history' && request.method === 'GET') {
      const entry = await getOwnedEntry(env, deps, userId, entryId);
      if (!entry) throw new HttpError(404, 'Entry not found');
      return deps.query(
        env,
        'SELECT id, entry_id, encrypted_snapshot, created_at FROM entry_history WHERE entry_id = ? ORDER BY created_at DESC, id DESC',
        [entryId],
      );
    }

    if (segments.length === 2 && request.method === 'PUT') {
      const body = await parseJsonBody(request);
      requireZbase32Id(body.history_id, 'history_id');
      requireBlobBase64(body.encrypted_data, 'encrypted_data', BLOB_MIN_LEN);
      requireBlobBase64(body.encrypted_snapshot, 'encrypted_snapshot', BLOB_MIN_LEN);

      const entry = await getOwnedEntry(env, deps, userId, entryId);
      if (!entry) throw new HttpError(404, 'Entry not found');

      const countRows = await deps.query(
        env,
        'SELECT COUNT(*) AS c FROM entry_history WHERE entry_id = ?',
        [entryId],
      );
      const count = Number(countRows[0]?.c || 0);
      const ts = nowIso();
      const statements = [];
      if (count >= 20) {
        statements.push({
          sql: 'DELETE FROM entry_history WHERE id = (SELECT id FROM entry_history WHERE entry_id = ? ORDER BY created_at ASC, id ASC LIMIT 1)',
          params: [entryId],
        });
      }
      statements.push(
        {
          sql: 'UPDATE entries SET encrypted_data = ?, updated_at = ? WHERE id = ? AND user_id = ?',
          params: [body.encrypted_data, ts, entryId, userId],
        },
        {
          sql: 'INSERT INTO entry_history (id, entry_id, encrypted_snapshot, created_at) VALUES (?, ?, ?, ?)',
          params: [body.history_id, entryId, body.encrypted_snapshot, ts],
        },
      );
      await runInTransaction(env, deps, statements);
      return { id: entryId, updated_at: ts };
    }

    if (segments.length === 2 && request.method === 'DELETE') {
      const entry = await getOwnedEntry(env, deps, userId, entryId);
      if (!entry) throw new HttpError(404, 'Entry not found');
      const ts = nowIso();
      await deps.execute(
        env,
        'UPDATE entries SET deleted_at = ? WHERE id = ? AND user_id = ?',
        [ts, entryId, userId],
      );
      return { id: entryId, deleted_at: ts };
    }

    if (segments.length === 3 && segments[2] === 'restore' && request.method === 'POST') {
      const entry = await getOwnedEntry(env, deps, userId, entryId);
      if (!entry) throw new HttpError(404, 'Entry not found');
      await deps.execute(
        env,
        'UPDATE entries SET deleted_at = NULL WHERE id = ? AND user_id = ?',
        [entryId, userId],
      );
      return { id: entryId };
    }

    if (segments.length === 3 && segments[2] === 'purge' && request.method === 'DELETE') {
      const entry = await getOwnedEntry(env, deps, userId, entryId);
      if (!entry) throw new HttpError(404, 'Entry not found');
      await runInTransaction(env, deps, [
        { sql: 'DELETE FROM entry_history WHERE entry_id = ?', params: [entryId] },
        { sql: 'DELETE FROM entries WHERE id = ? AND user_id = ?', params: [entryId, userId] },
      ]);
      return { id: entryId };
    }
  }

  throw new HttpError(404, 'Not found');
}

async function handleKeys(request, env, deps, userId, segments) {
  if (segments.length === 1 && request.method === 'GET') {
    return deps.query(
      env,
      'SELECT key_id, type, label, peer_user_id, created_at FROM key_store WHERE user_id = ? ORDER BY created_at DESC',
      [userId],
    );
  }

  if (segments.length === 1 && request.method === 'POST') {
    const body = await parseJsonBody(request);
    requireZbase32Id(body.key_id, 'key_id');
    if (!KEY_TYPES.has(body.type)) throw new HttpError(400, 'Invalid type');

    const label = body.label == null ? null : String(body.label);
    const peerUserId = body.peer_user_id == null ? null : String(body.peer_user_id);

    if (body.type === 'peer_public') {
      requireZbase32Id(peerUserId, 'peer_user_id');
      if (peerUserId === userId) throw new HttpError(400, 'peer_user_id must not equal own user_id');
    }
    if (body.type !== 'peer_public' && peerUserId != null) {
      throw new HttpError(400, 'peer_user_id only allowed for peer_public');
    }

    requireBlobBase64(body.encrypted_data, 'encrypted_data', BLOB_MIN_LEN);
    const ts = nowIso();
    await deps.execute(
      env,
      'INSERT INTO key_store (key_id, user_id, type, label, encrypted_data, peer_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [body.key_id, userId, body.type, label, body.encrypted_data, peerUserId, ts],
    );
    return { key_id: body.key_id, created_at: ts, _status: 201 };
  }

  if (segments.length === 2) {
    const keyId = segments[1];
    requireZbase32Id(keyId, 'key_id');

    if (request.method === 'GET') {
      const row = await getOwnedKey(env, deps, userId, keyId);
      if (!row) throw new HttpError(404, 'Key not found');
      return row;
    }
    if (request.method === 'DELETE') {
      const row = await getOwnedKey(env, deps, userId, keyId);
      if (!row) throw new HttpError(404, 'Key not found');
      await deps.execute(
        env,
        'DELETE FROM key_store WHERE key_id = ? AND user_id = ?',
        [keyId, userId],
      );
      return { key_id: keyId };
    }
  }

  throw new HttpError(404, 'Not found');
}

async function handlePublicKey(request, env, deps, segments) {
  if (request.method !== 'GET' || segments.length !== 3 || segments[2] !== 'public-key') {
    throw new HttpError(404, 'Not found');
  }
  const targetUserId = segments[1];
  requireZbase32Id(targetUserId, 'user_id');

  const rows = await deps.query(
    env,
    'SELECT encrypted_data FROM key_store WHERE user_id = ? AND type = ? ORDER BY created_at DESC LIMIT 1',
    [targetUserId, 'own_public'],
  );
  if (!rows[0]?.encrypted_data) throw new HttpError(404, 'Public key not found');
  return {
    user_id: targetUserId,
    public_key: rows[0].encrypted_data,
  };
}

export function createFetchHandler(customDeps = {}) {
  const deps = {
    verifyFirebaseToken,
    deriveUserId,
    query,
    execute,
    executeBatch,
    ...customDeps,
  };

  return async function fetchHandler(request, env) {
    const origin = request.headers.get('Origin') || '*';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    try {
      const url = new URL(request.url);
      const segments = splitPath(url.pathname);

      if (request.method === 'GET' && url.pathname === '/health') {
        return json({ ok: true }, 200, origin);
      }

      const { userId } = await requireAuthContext(request, env, deps);

      if (segments[0] === 'entries') {
        const data = await handleEntries(request, env, deps, userId, segments);
        const status = data?._status || 200;
        if (data && typeof data === 'object' && '_status' in data) delete data._status;
        return json(data, status, origin);
      }

      if (segments[0] === 'keys') {
        const data = await handleKeys(request, env, deps, userId, segments);
        const status = data?._status || 200;
        if (data && typeof data === 'object' && '_status' in data) delete data._status;
        return json(data, status, origin);
      }

      if (segments[0] === 'users') {
        const data = await handlePublicKey(request, env, deps, segments);
        return json(data, 200, origin);
      }

      throw new HttpError(404, 'Not found');
    } catch (err) {
      const status = Number.isInteger(err?.status) ? err.status : 500;
      return json({ error: err?.message || 'Unexpected error' }, status, origin);
    }
  };
}

export default {
  fetch: createFetchHandler(),
};
