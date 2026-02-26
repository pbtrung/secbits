import { bytesToB64, decodeRootMasterKey, decryptBlobBytes, encryptBytesToBlob } from './crypto';

const MAX_COMMITS = 20;

let session = null;
let rootMasterKeyBytes = null;
let entriesCache = [];
let trashCache = [];
let userName = '';
let vaultLoaded = false;
let vaultBlobSize = 0;
let loadPromise = null;

function zeroizeBytes(bytes) {
  if (bytes instanceof Uint8Array) bytes.fill(0);
}

function b64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function parseJwtPayload(idToken) {
  const parts = String(idToken).split('.');
  if (parts.length !== 3) return null;
  try {
    const body = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = body + '='.repeat((4 - (body.length % 4)) % 4);
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

function ensureSession() {
  if (!session) throw new Error('Session is not initialized');
  return session;
}

function ensureRootKey() {
  if (!(rootMasterKeyBytes instanceof Uint8Array)) {
    throw new Error('Root master key is not initialized');
  }
  return rootMasterKeyBytes;
}

function normalizeR2Config(r2) {
  if (!r2 || typeof r2 !== 'object') throw new Error('Missing required field: r2');
  const bucket_name = String(r2.bucket_name || '').trim();
  const file_name = String(r2.file_name || '').trim();
  const prefix = String(r2.prefix || '').trim();
  if (!bucket_name) throw new Error('Missing required field: r2.bucket_name');
  if (!file_name) throw new Error('Missing required field: r2.file_name');
  if (!prefix) throw new Error('Missing required field: r2.prefix');
  return { bucket_name, file_name, prefix };
}

async function refreshIdTokenIfNeeded() {
  const s = ensureSession();
  if (!s.idToken || !s.refreshToken || !s.firebaseApiKey) throw new Error('Auth session is incomplete');

  const now = Date.now();
  if (s.idTokenExpiresAtMs - now > 5 * 60 * 1000) return;

  const res = await fetch(`https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(s.firebaseApiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(s.refreshToken)}`,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.id_token) {
    throw new Error(data?.error?.message || 'Failed to refresh Firebase token');
  }

  const payload = parseJwtPayload(data.id_token);
  const expMs = payload?.exp ? Number(payload.exp) * 1000 : now + 45 * 60 * 1000;

  s.idToken = data.id_token;
  s.refreshToken = data.refresh_token || s.refreshToken;
  s.idTokenExpiresAtMs = expMs;
}

async function workerFetch(path, options = {}) {
  const s = ensureSession();
  await refreshIdTokenIfNeeded();

  const url = new URL(path, s.workerUrl);
  const headers = new Headers(options.headers || {});
  headers.set('Authorization', `Bearer ${s.idToken}`);

  const res = await fetch(url.toString(), {
    ...options,
    headers,
  });

  return res;
}

function normalizeTags(tags) {
  if (Array.isArray(tags)) {
    return tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean);
  }
  if (typeof tags === 'string') {
    return tags
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
  }
  return [];
}

function normalizeCustomFields(customFields) {
  if (!Array.isArray(customFields)) return [];
  const seen = new Set();
  return customFields.map((field, index) => {
    let id = Number.isFinite(field?.id) ? field.id : index + 1;
    while (seen.has(id)) id++;
    seen.add(id);
    return {
      id,
      label: typeof field?.label === 'string' ? field.label : '',
      value: typeof field?.value === 'string' ? field.value : '',
    };
  });
}

function normalizeTotpSecrets(totpSecrets) {
  if (!Array.isArray(totpSecrets)) return [];
  return totpSecrets.map((secret) => String(secret ?? '')).filter((secret) => secret.length > 0);
}

function normalizeTimestamp(timestamp) {
  if (typeof timestamp === 'string') {
    const ms = Date.parse(timestamp);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  return new Date().toISOString();
}

function normalizeEntryShape(entry) {
  const safe = entry && typeof entry === 'object' ? entry : {};
  const customFields = normalizeCustomFields(
    Array.isArray(safe.customFields) ? safe.customFields : safe.hiddenFields,
  );
  return {
    title: typeof safe.title === 'string' ? safe.title : '',
    username: typeof safe.username === 'string' ? safe.username : '',
    password: typeof safe.password === 'string' ? safe.password : '',
    notes: typeof safe.notes === 'string' ? safe.notes : '',
    urls: Array.isArray(safe.urls) ? safe.urls.map((v) => String(v ?? '')) : [],
    totpSecrets: normalizeTotpSecrets(safe.totpSecrets),
    customFields,
    tags: normalizeTags(safe.tags),
    timestamp: normalizeTimestamp(safe.timestamp),
  };
}

async function contentHash(obj) {
  const stable = {};
  for (const key of Object.keys(obj).sort()) stable[key] = obj[key];
  const data = new TextEncoder().encode(JSON.stringify(stable));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}

const TRACKED_FIELDS = ['title', 'username', 'password', 'notes', 'urls', 'totpSecrets', 'customFields', 'tags'];

function diffFields(prevSnapshot, nextSnapshot) {
  return TRACKED_FIELDS.filter(
    (field) => JSON.stringify(prevSnapshot?.[field]) !== JSON.stringify(nextSnapshot?.[field]),
  );
}

async function buildNextHistory(existingCommits, payload) {
  const commits = Array.isArray(existingCommits) ? existingCommits : [];
  const headCommit = commits[0] ?? null;

  const { timestamp, ...content } = payload;
  const hash = await contentHash(content);

  if (headCommit && headCommit.hash === hash) {
    return commits;
  }

  const newCommit = {
    hash,
    parent: headCommit?.hash ?? null,
    timestamp: new Date().toISOString(),
    changed: headCommit ? diffFields(headCommit.snapshot, payload) : [],
    snapshot: payload,
  };

  return [newCommit, ...commits].slice(0, MAX_COMMITS);
}

function normalizeEntryForState(entry) {
  const safe = entry && typeof entry === 'object' ? entry : {};
  const normalized = normalizeEntryShape(safe);
  const commits = Array.isArray(safe._commits)
    ? safe._commits
      .filter((c) => c && typeof c === 'object' && c.snapshot && typeof c.snapshot === 'object')
      .map((c) => ({
        hash: typeof c.hash === 'string' ? c.hash : null,
        parent: c.parent == null ? null : String(c.parent),
        timestamp: normalizeTimestamp(c.timestamp),
        changed: Array.isArray(c.changed) ? c.changed.map((f) => String(f)) : [],
        snapshot: normalizeEntryShape(c.snapshot),
      }))
      .slice(0, MAX_COMMITS)
    : [];

  if (commits.length === 0) {
    const snapshot = { ...normalized, timestamp: normalizeTimestamp(normalized.timestamp) };
    return {
      id: typeof safe.id === 'string' ? safe.id : crypto.randomUUID(),
      ...normalized,
      _commits: [{
        hash: null,
        parent: null,
        timestamp: snapshot.timestamp,
        changed: [],
        snapshot,
      }],
    };
  }

  const latest = commits[0].snapshot;
  return {
    id: typeof safe.id === 'string' ? safe.id : crypto.randomUUID(),
    ...latest,
    _commits: commits,
  };
}

function normalizeVaultData(data) {
  if (!Array.isArray(data)) return [];
  return data.map(normalizeEntryForState);
}

function normalizeVaultTrash(data) {
  if (!Array.isArray(data)) return [];
  return data.map((entry) => {
    const normalized = normalizeEntryForState(entry);
    return {
      ...normalized,
      deletedAt: normalizeTimestamp(entry?.deletedAt),
    };
  });
}

export function setRootMasterKey(keyBytes) {
  if (!(keyBytes instanceof Uint8Array)) throw new Error('Root master key must be bytes');
  zeroizeBytes(rootMasterKeyBytes);
  rootMasterKeyBytes = keyBytes.slice();
}

export function getRootMasterKey() {
  return rootMasterKeyBytes;
}

export function decodeRootMasterKeyFromConfig(value) {
  return decodeRootMasterKey(value);
}

export async function initApi(config) {
  const workerUrl = String(config.worker_url || '').trim();
  if (!workerUrl) throw new Error('Missing required field: worker_url');
  if (!config.email) throw new Error('Missing required field: email');
  if (!config.password) throw new Error('Missing required field: password');
  if (!config.firebase_api_key) throw new Error('Missing required field: firebase_api_key');
  const vaultId = String(config.vault_id || '').trim();
  if (!vaultId) throw new Error('Missing required field: vault_id');

  const r2 = normalizeR2Config(config.r2);

  const signInRes = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(config.firebase_api_key)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: config.email,
        password: config.password,
        returnSecureToken: true,
      }),
    },
  );

  const auth = await signInRes.json().catch(() => ({}));
  if (!signInRes.ok || !auth?.idToken) {
    throw new Error(auth?.error?.message || 'Firebase authentication failed');
  }

  const payload = parseJwtPayload(auth.idToken);
  const now = Date.now();

  session = {
    workerUrl: workerUrl.endsWith('/') ? workerUrl : `${workerUrl}/`,
    firebaseApiKey: config.firebase_api_key,
    idToken: auth.idToken,
    refreshToken: auth.refreshToken,
    idTokenExpiresAtMs: payload?.exp ? Number(payload.exp) * 1000 : now + 45 * 60 * 1000,
    uid: auth.localId || payload?.sub || null,
    vaultId,
    r2,
  };

  userName = typeof config.username === 'string' ? config.username : '';
  entriesCache = [];
  trashCache = [];
  vaultLoaded = false;
  loadPromise = null;

  return {
    userId: session.uid || 'unknown-user',
    username: userName,
  };
}

export function getUsername() {
  return userName;
}

export function clearUserMasterKey() {
  zeroizeBytes(rootMasterKeyBytes);
  rootMasterKeyBytes = null;
  session = null;
  entriesCache = [];
  trashCache = [];
  userName = '';
  vaultLoaded = false;
  vaultBlobSize = 0;
  loadPromise = null;
}

function vaultKeySearchParams(r2, vaultId) {
  return {
    bucket_name: r2.bucket_name,
    prefix: r2.prefix,
    vault_id: vaultId,
    file_name: r2.file_name,
  };
}

export function buildExportData({ username, entries, trash }) {
  return {
    version: 1,
    username: typeof username === 'string' ? username : '',
    data: Array.isArray(entries) ? entries : [],
    trash: Array.isArray(trash) ? trash : [],
  };
}

async function readVaultFromRemote() {
  const s = ensureSession();
  const res = await workerFetch('/vault/read', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(vaultKeySearchParams(s.r2, s.vaultId)),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error || `Failed to read vault (${res.status})`);
  }

  const body = await res.json();
  if (body?.exists === false) {
    return { username: userName, data: [], trash: [] };
  }

  const payloadB64 = body?.payload_b64;
  if (!payloadB64) {
    return { username: userName, data: [], trash: [] };
  }

  const blobBytes = b64ToBytes(payloadB64);
  vaultBlobSize = blobBytes.length;
  const rootKey = ensureRootKey();

  let jsonBytes;
  try {
    jsonBytes = await decryptBlobBytes(rootKey, blobBytes);
  } catch {
    throw new Error('Wrong root master key');
  }

  const brotli = await (await import('brotli-wasm')).default;
  const plainBytes = brotli.decompress(jsonBytes);
  const text = new TextDecoder().decode(plainBytes);
  const parsed = JSON.parse(text);

  return {
    username: typeof parsed?.username === 'string' ? parsed.username : userName,
    data: Array.isArray(parsed?.data) ? parsed.data : [],
    trash: Array.isArray(parsed?.trash) ? parsed.trash : [],
  };
}

async function writeVaultToRemote(entries, trash) {
  const s = ensureSession();
  const rootKey = ensureRootKey();
  const exportData = buildExportData({ username: userName, entries, trash });

  const jsonBytes = new TextEncoder().encode(JSON.stringify(exportData));
  const brotli = await (await import('brotli-wasm')).default;
  const compressed = brotli.compress(jsonBytes);
  const encryptedBlob = await encryptBytesToBlob(rootKey, compressed);
  vaultBlobSize = encryptedBlob.length;

  const res = await workerFetch('/vault/write', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...vaultKeySearchParams(s.r2, s.vaultId),
      payload_b64: bytesToB64(encryptedBlob),
    }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error || `Failed to write vault (${res.status})`);
  }
}

async function ensureVaultLoaded() {
  if (vaultLoaded) return;
  if (!loadPromise) {
    loadPromise = (async () => {
      const vault = await readVaultFromRemote();
      userName = vault.username || userName;
      entriesCache = normalizeVaultData(vault.data);
      trashCache = normalizeVaultTrash(vault.trash);
      vaultLoaded = true;
    })().finally(() => { loadPromise = null; });
  }
  await loadPromise;
}

export async function fetchUserEntries() {
  await ensureVaultLoaded();
  return {
    entries: entriesCache.map((e) => ({ ...e, _commits: Array.isArray(e._commits) ? e._commits : [] })),
    trash: trashCache.map((e) => ({ ...e, _commits: Array.isArray(e._commits) ? e._commits : [] })),
    failedCount: 0,
  };
}

function toEntryPayload(entry) {
  return {
    ...normalizeEntryShape(entry),
    timestamp: new Date().toISOString(),
  };
}

export async function createUserEntry(entry) {
  await ensureVaultLoaded();

  const payload = toEntryPayload(entry);
  const commits = await buildNextHistory([], payload);
  const created = {
    id: crypto.randomUUID(),
    ...payload,
    _commits: commits,
  };

  entriesCache = [created, ...entriesCache];
  await writeVaultToRemote(entriesCache, trashCache);
  return created;
}

export async function updateUserEntry(entryId, entry) {
  await ensureVaultLoaded();

  const idx = entriesCache.findIndex((e) => e.id === entryId);
  if (idx < 0) throw new Error('Entry not found');

  const payload = toEntryPayload(entry);
  const commits = await buildNextHistory(entriesCache[idx]._commits, payload);
  const updated = {
    id: entryId,
    ...payload,
    _commits: commits,
  };

  entriesCache = entriesCache.map((e, i) => (i === idx ? updated : e));
  await writeVaultToRemote(entriesCache, trashCache);
  return updated;
}

export async function restoreEntryVersion(entryId, commitHash) {
  await ensureVaultLoaded();

  const idx = entriesCache.findIndex((e) => e.id === entryId);
  if (idx < 0) throw new Error('Entry not found');

  const commits = entriesCache[idx]._commits || [];
  const target = commits.find((c) => c.hash === commitHash);
  if (!target) throw new Error('Commit not found');

  const payload = {
    ...normalizeEntryShape(target.snapshot),
    timestamp: new Date().toISOString(),
  };

  const nextCommits = await buildNextHistory(commits, payload);
  const restored = {
    id: entryId,
    ...payload,
    _commits: nextCommits,
  };

  entriesCache = entriesCache.map((e, i) => (i === idx ? restored : e));
  await writeVaultToRemote(entriesCache, trashCache);
  return restored;
}

export async function deleteUserEntry(entryId) {
  await ensureVaultLoaded();
  const idx = entriesCache.findIndex((e) => e.id === entryId);
  if (idx < 0) throw new Error('Entry not found');
  const entry = entriesCache[idx];
  const trashed = {
    ...entry,
    deletedAt: new Date().toISOString(),
  };
  entriesCache = entriesCache.filter((e) => e.id !== entryId);
  trashCache = [trashed, ...trashCache.filter((e) => e.id !== entryId)];
  await writeVaultToRemote(entriesCache, trashCache);
  return trashed;
}

export async function restoreDeletedUserEntry(entryId) {
  await ensureVaultLoaded();
  const idx = trashCache.findIndex((e) => e.id === entryId);
  if (idx < 0) throw new Error('Deleted entry not found');
  const source = trashCache[idx];
  const restored = normalizeEntryForState(source);
  entriesCache = [restored, ...entriesCache.filter((e) => e.id !== entryId)];
  trashCache = trashCache.filter((e) => e.id !== entryId);
  await writeVaultToRemote(entriesCache, trashCache);
  return restored;
}

export async function restoreDeletedEntryVersion(entryId, commitHash) {
  await ensureVaultLoaded();
  const idx = trashCache.findIndex((e) => e.id === entryId);
  if (idx < 0) throw new Error('Deleted entry not found');
  const commits = trashCache[idx]._commits || [];
  const target = commits.find((c) => c.hash === commitHash);
  if (!target) throw new Error('Commit not found');

  const payload = {
    ...normalizeEntryShape(target.snapshot),
    timestamp: new Date().toISOString(),
  };

  const nextCommits = await buildNextHistory(commits, payload);
  const restored = {
    id: entryId,
    ...payload,
    _commits: nextCommits,
  };

  entriesCache = [restored, ...entriesCache.filter((e) => e.id !== entryId)];
  trashCache = trashCache.filter((e) => e.id !== entryId);
  await writeVaultToRemote(entriesCache, trashCache);
  return restored;
}

export async function permanentlyDeleteUserEntry(entryId) {
  await ensureVaultLoaded();
  const exists = trashCache.some((e) => e.id === entryId);
  if (!exists) throw new Error('Deleted entry not found');
  trashCache = trashCache.filter((e) => e.id !== entryId);
  await writeVaultToRemote(entriesCache, trashCache);
}

export async function rotateRootMasterKey(newRootMasterKeyBytes) {
  if (!(newRootMasterKeyBytes instanceof Uint8Array)) {
    throw new Error('New root master key must be bytes');
  }
  await ensureVaultLoaded();

  const previous = rootMasterKeyBytes instanceof Uint8Array ? rootMasterKeyBytes.slice() : null;
  setRootMasterKey(newRootMasterKeyBytes);

  try {
    await writeVaultToRemote(entriesCache, trashCache);
  } catch (err) {
    zeroizeBytes(rootMasterKeyBytes);
    rootMasterKeyBytes = previous;
    throw err;
  }

  zeroizeBytes(previous);
}

export function getVaultStats() {
  const count = entriesCache.length;
  const trashCount = trashCache.length;
  const payload = JSON.stringify(buildExportData({ username: userName, entries: entriesCache, trash: trashCache }));
  const totalBytes = new TextEncoder().encode(payload).length;
  return {
    count,
    trashCount,
    totalCount: count + trashCount,
    totalBytes,
    avgBytes: count + trashCount ? Math.round(totalBytes / (count + trashCount)) : 0,
    blobSize: vaultBlobSize,
  };
}

export const __historyFormatTestOnly = {
  normalizeEntryShape,
};
