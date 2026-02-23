import { verifyPassword, signJWT, verifyJWT } from './auth.js';
import {
  getUserByEmail, getUserById, updateUserMasterKey,
  getEntries, getEntryById, createEntry, updateEntry, deleteEntry,
} from './db.js';

const MAX_VALUE_BYTES = 1_900_000;
const JWT_TTL = 8 * 60 * 60; // 8 hours in seconds

// ─── Binary helpers ───────────────────────────────────────────────────────────

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

// ─── Response helpers ─────────────────────────────────────────────────────────

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

// ─── Auth middleware ──────────────────────────────────────────────────────────

async function requireAuth(request, env) {
  const header = request.headers.get('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  return verifyJWT(token, env.JWT_SECRET);
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const method = request.method;
    const path = url.pathname;

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // POST /auth/login
    if (method === 'POST' && path === '/auth/login') {
      let body;
      try { body = await request.json(); } catch { return err('Invalid JSON', 400, origin); }
      const { email, password } = body;
      if (!email || !password) return err('Missing credentials', 400, origin);
      const user = await getUserByEmail(env.DB, email);
      if (!user) return err('Invalid credentials', 401, origin);
      const ok = await verifyPassword(password, user.password_hash);
      if (!ok) return err('Invalid credentials', 401, origin);
      const now = Math.floor(Date.now() / 1000);
      const token = await signJWT({ sub: user.id, exp: now + JWT_TTL }, env.JWT_SECRET);
      return json({ token, userId: user.id, username: user.username }, 200, origin);
    }

    // All other routes: /users/:userId/...
    const userMatch = path.match(/^\/users\/([^/]+)(\/.*)?$/);
    if (!userMatch) return err('Not found', 404, origin);
    const routeUserId = userMatch[1];
    const subPath = userMatch[2] ?? '/';

    const payload = await requireAuth(request, env);
    if (!payload) return err('Unauthorized', 401, origin);
    if (payload.sub !== routeUserId) return err('Forbidden', 403, origin);

    // GET /users/:userId/profile
    if (method === 'GET' && subPath === '/profile') {
      const user = await getUserById(env.DB, routeUserId);
      if (!user) return err('User not found', 404, origin);
      return json({
        username: user.username,
        user_master_key: user.user_master_key ? bufToB64(user.user_master_key) : null,
      }, 200, origin);
    }

    // POST /users/:userId/profile  (save user_master_key)
    if (method === 'POST' && subPath === '/profile') {
      let body;
      try { body = await request.json(); } catch { return err('Invalid JSON', 400, origin); }
      const { user_master_key } = body;
      if (!user_master_key) return err('Missing user_master_key', 400, origin);
      let blob;
      try { blob = b64ToBuf(user_master_key); } catch { return err('Invalid base64', 400, origin); }
      await updateUserMasterKey(env.DB, routeUserId, blob);
      return json({ ok: true }, 200, origin);
    }

    // GET /users/:userId/entries
    if (method === 'GET' && subPath === '/entries') {
      const rows = await getEntries(env.DB, routeUserId);
      const entries = rows.map(r => ({
        id: r.id,
        entry_key: bufToB64(r.entry_key),
        value: bufToB64(r.value),
      }));
      return json(entries, 200, origin);
    }

    // POST /users/:userId/entries
    if (method === 'POST' && subPath === '/entries') {
      let body;
      try { body = await request.json(); } catch { return err('Invalid JSON', 400, origin); }
      const { id, entry_key, value } = body;
      if (!id || !entry_key || !value) return err('Missing fields', 400, origin);
      let entryKeyBlob, valueBlob;
      try {
        entryKeyBlob = b64ToBuf(entry_key);
        valueBlob = b64ToBuf(value);
      } catch { return err('Invalid base64', 400, origin); }
      if (valueBlob.length >= MAX_VALUE_BYTES) return err('Entry too large', 413, origin);
      await createEntry(env.DB, id, routeUserId, entryKeyBlob, valueBlob);
      return json({ ok: true }, 201, origin);
    }

    // Single-entry routes: /users/:userId/entries/:entryId
    const entryMatch = subPath.match(/^\/entries\/([^/]+)$/);

    // GET /users/:userId/entries/:entryId
    if (method === 'GET' && entryMatch) {
      const entryId = entryMatch[1];
      const row = await getEntryById(env.DB, routeUserId, entryId);
      if (!row) return err('Entry not found', 404, origin);
      return json({
        id: row.id,
        entry_key: bufToB64(row.entry_key),
        value: bufToB64(row.value),
      }, 200, origin);
    }

    // PUT /users/:userId/entries/:entryId
    if (method === 'PUT' && entryMatch) {
      const entryId = entryMatch[1];
      let body;
      try { body = await request.json(); } catch { return err('Invalid JSON', 400, origin); }
      const { entry_key, value } = body;
      if (!entry_key || !value) return err('Missing fields', 400, origin);
      let entryKeyBlob, valueBlob;
      try {
        entryKeyBlob = b64ToBuf(entry_key);
        valueBlob = b64ToBuf(value);
      } catch { return err('Invalid base64', 400, origin); }
      if (valueBlob.length >= MAX_VALUE_BYTES) return err('Entry too large', 413, origin);
      await updateEntry(env.DB, entryId, routeUserId, entryKeyBlob, valueBlob);
      return json({ ok: true }, 200, origin);
    }

    // DELETE /users/:userId/entries/:entryId
    if (method === 'DELETE' && entryMatch) {
      const entryId = entryMatch[1];
      await deleteEntry(env.DB, routeUserId, entryId);
      return json({ ok: true }, 200, origin);
    }

    return err('Not found', 404, origin);
  },
};
