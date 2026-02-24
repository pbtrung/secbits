import { verifyFirebaseToken } from './firebase.js';
import {
  getUserById,
  provisionUser,
  updateUserProfile,
  getEntries,
  getEntryById,
  createEntry,
  updateEntry,
  deleteEntry,
} from './db.js';

const MAX_VALUE_BYTES = 1_900_000;

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status: status ?? 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

function err(msg, status, origin) {
  return json({ error: msg }, status, origin);
}

function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function b64ToBuf(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function requireAuth(request, env) {
  const header = request.headers.get('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  try {
    const payload = await verifyFirebaseToken(token, env.FIREBASE_PROJECT_ID);
    return payload;
  } catch {
    return null;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const method = request.method;
    const path = url.pathname;

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (!env.FIREBASE_PROJECT_ID) {
      return err('Server misconfigured', 500, origin);
    }

    const payload = await requireAuth(request, env);
    if (!payload) {
      return err('Unauthorized', 401, origin);
    }
    const userId = payload.sub;

    await provisionUser(env.DB, userId);

    if (method === 'GET' && path === '/me/profile') {
      const user = await getUserById(env.DB, userId);
      if (!user) return err('User not found', 404, origin);
      return json({
        username: user.username,
        user_master_key: user.user_master_key ? bufToB64(user.user_master_key) : null,
      }, 200, origin);
    }

    if (method === 'POST' && path === '/me/profile') {
      let body;
      try {
        body = await request.json();
      } catch {
        return err('Invalid JSON', 400, origin);
      }
      const { user_master_key: userMasterKeyB64, username } = body ?? {};
      if (!userMasterKeyB64) return err('Missing user_master_key', 400, origin);
      let blob;
      try {
        blob = b64ToBuf(userMasterKeyB64);
      } catch {
        return err('Invalid base64', 400, origin);
      }

      await updateUserProfile(env.DB, userId, blob, username);
      return json({ ok: true }, 200, origin);
    }

    if (method === 'GET' && path === '/entries') {
      const rows = await getEntries(env.DB, userId);
      const entries = rows.map((r) => ({
        id: r.id,
        entry_key: bufToB64(r.entry_key),
        value: bufToB64(r.value),
      }));
      return json(entries, 200, origin);
    }

    if (method === 'POST' && path === '/entries') {
      let body;
      try {
        body = await request.json();
      } catch {
        return err('Invalid JSON', 400, origin);
      }
      const { id, entry_key: entryKeyB64, value: valueB64 } = body ?? {};
      if (!id || !entryKeyB64 || !valueB64) return err('Missing fields', 400, origin);

      let entryKeyBlob;
      let valueBlob;
      try {
        entryKeyBlob = b64ToBuf(entryKeyB64);
        valueBlob = b64ToBuf(valueB64);
      } catch {
        return err('Invalid base64', 400, origin);
      }
      if (valueBlob.length >= MAX_VALUE_BYTES) return err('Entry too large', 413, origin);

      try {
        await createEntry(env.DB, id, userId, entryKeyBlob, valueBlob);
      } catch {
        return err('Failed to create entry', 400, origin);
      }
      return json({ ok: true }, 201, origin);
    }

    const entryMatch = path.match(/^\/entries\/([^/]+)$/);
    if (entryMatch) {
      const entryId = entryMatch[1];

      if (method === 'GET') {
        const row = await getEntryById(env.DB, userId, entryId);
        if (!row) return err('Entry not found', 404, origin);
        return json({
          id: row.id,
          entry_key: bufToB64(row.entry_key),
          value: bufToB64(row.value),
        }, 200, origin);
      }

      if (method === 'PUT') {
        let body;
        try {
          body = await request.json();
        } catch {
          return err('Invalid JSON', 400, origin);
        }
        const { entry_key: entryKeyB64, value: valueB64 } = body ?? {};
        if (!entryKeyB64 || !valueB64) return err('Missing fields', 400, origin);

        let entryKeyBlob;
        let valueBlob;
        try {
          entryKeyBlob = b64ToBuf(entryKeyB64);
          valueBlob = b64ToBuf(valueB64);
        } catch {
          return err('Invalid base64', 400, origin);
        }
        if (valueBlob.length >= MAX_VALUE_BYTES) return err('Entry too large', 413, origin);

        const changed = await updateEntry(env.DB, entryId, userId, entryKeyBlob, valueBlob);
        if (!changed) return err('Entry not found', 404, origin);
        return json({ ok: true }, 200, origin);
      }

      if (method === 'DELETE') {
        const changed = await deleteEntry(env.DB, userId, entryId);
        if (!changed) return err('Entry not found', 404, origin);
        return json({ ok: true }, 200, origin);
      }
    }

    return err('Not found', 404, origin);
  },
};
