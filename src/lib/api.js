import {
  decodeRootMasterKey,
  decryptEntry,
  decryptEntryKey,
  decryptUMK,
  encryptBlob,
  encryptEntry,
  encryptEntryKey,
  encryptUMK,
  generateEntryKey,
  generateMlkem1024X448KeyPair,
  bytesToB64,
} from './crypto';
import { computeCommitHash } from './commitHash';
import { zbase32Encode } from './zbase32';

const MAX_COMMITS = 20;

let session = null;
let rootMasterKeyBytes = null;
let umkKeyRecord = null;
let umkBytes = null;
let entriesCache = [];
let trashCache = [];
let entryKeyById = new Map(); // id -> raw 64-byte entry key
let userName = '';
let loadPromise = null;
let vaultBlobSize = 0;

const VALID_ENTRY_TYPES = ['login', 'note', 'card'];
const TRACKED_FIELDS = ['title', 'username', 'password', 'notes', 'urls', 'totpSecrets', 'customFields', 'tags', 'cardholderName', 'cardNumber', 'cardExpiry', 'cardCvv'];

function zeroizeBytes(bytes) {
  if (bytes instanceof Uint8Array) bytes.fill(0);
}

function b64ToBytes(value) {
  const bin = atob(value);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function parseJwtPayload(idToken) {
  const parts = String(idToken || '').split('.');
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

function ensureUMK() {
  if (!(umkBytes instanceof Uint8Array)) {
    throw new Error('User master key is not initialized');
  }
  return umkBytes;
}

function randomId() {
  return zbase32Encode(crypto.getRandomValues(new Uint8Array(32)));
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
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

  const res = await fetch(url.toString(), {
    ...options,
    headers,
  });
  return res;
}

function makeApiError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

async function requestJson(path, options = {}) {
  const res = await workerFetch(path, options);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const msg = body?.error || `Request failed (${res.status})`;
    if (res.status === 401) throw makeApiError('AUTH_ERROR', msg);
    if (res.status === 400) throw makeApiError('VALIDATION_ERROR', msg);
    throw makeApiError('API_ERROR', msg);
  }
  return res.status === 204 ? null : res.json();
}

function normalizeTags(tags) {
  if (Array.isArray(tags)) return tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean);
  if (typeof tags === 'string') return tags.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
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
  return totpSecrets.map((secret) => String(secret ?? '')).filter(Boolean);
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
  const customFields = normalizeCustomFields(Array.isArray(safe.customFields) ? safe.customFields : safe.hiddenFields);
  const result = {
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
  if (VALID_ENTRY_TYPES.includes(safe.type)) result.type = safe.type;
  if (safe.type === 'card') {
    result.cardholderName = typeof safe.cardholderName === 'string' ? safe.cardholderName : '';
    result.cardNumber = typeof safe.cardNumber === 'string' ? safe.cardNumber : '';
    result.cardExpiry = typeof safe.cardExpiry === 'string' ? safe.cardExpiry : '';
    result.cardCvv = typeof safe.cardCvv === 'string' ? safe.cardCvv : '';
  }
  return result;
}

function diffFields(prevSnapshot, nextSnapshot) {
  return TRACKED_FIELDS.filter((field) => JSON.stringify(prevSnapshot?.[field]) !== JSON.stringify(nextSnapshot?.[field]));
}

async function buildSnapshotPayload(entryPayload) {
  const snapshot = { ...normalizeEntryShape(entryPayload), timestamp: normalizeTimestamp(entryPayload.timestamp) };
  const commitHash = await computeCommitHash(snapshot);
  return { ...snapshot, commit_hash: commitHash };
}

async function decodeHistorySnapshots(historyRows, rawEntryKey) {
  const snapshots = await Promise.all(
    historyRows.map(async (row) => {
      const snapshot = await decryptEntry(b64ToBytes(row.encrypted_snapshot), rawEntryKey);
      return { snapshot, timestamp: normalizeTimestamp(row.created_at) };
    }),
  );

  const commits = [];
  for (let i = 0; i < snapshots.length; i++) {
    const current = snapshots[i];
    const parent = snapshots[i + 1] || null;
    const snapshotNoHash = { ...current.snapshot };
    const hash = typeof snapshotNoHash.commit_hash === 'string'
      ? snapshotNoHash.commit_hash
      : await computeCommitHash(snapshotNoHash);
    delete snapshotNoHash.commit_hash;

    commits.push({
      hash,
      parent: parent
        ? (typeof parent.snapshot.commit_hash === 'string'
          ? parent.snapshot.commit_hash
          : await computeCommitHash({ ...parent.snapshot, commit_hash: undefined }))
        : null,
      timestamp: current.timestamp,
      changed: parent ? diffFields(parent.snapshot, snapshotNoHash) : [],
      snapshot: normalizeEntryShape(snapshotNoHash),
    });
  }
  return commits.slice(0, MAX_COMMITS);
}

async function hydrateEntryRow(row, isTrash = false) {
  const currentUMK = ensureUMK();
  const rawEntryKey = await decryptEntryKey(b64ToBytes(row.entry_key), currentUMK);
  entryKeyById.set(row.id, rawEntryKey);

  const decrypted = normalizeEntryShape(await decryptEntry(b64ToBytes(row.encrypted_data), rawEntryKey));
  const historyRows = await getHistory(row.id);
  const commits = await decodeHistorySnapshots(historyRows, rawEntryKey);
  const head = commits[0]?.snapshot || decrypted;

  const hydrated = {
    id: row.id,
    ...head,
    _commits: commits,
    _entryMeta: {
      created_at: row.created_at,
      updated_at: row.updated_at,
      deleted_at: row.deleted_at || null,
      entry_key_blob: row.entry_key,
    },
  };
  if (isTrash) hydrated.deletedAt = normalizeTimestamp(row.deleted_at);

  const encryptedBytes = b64ToBytes(row.encrypted_data).length + b64ToBytes(row.entry_key).length;
  vaultBlobSize += encryptedBytes;
  for (const h of historyRows) {
    vaultBlobSize += b64ToBytes(h.encrypted_snapshot).length;
  }

  return hydrated;
}

async function ensureVaultLoaded() {
  if (entriesCache.length || trashCache.length || loadPromise) {
    if (loadPromise) await loadPromise;
    return;
  }

  loadPromise = (async () => {
    vaultBlobSize = 0;
    const [liveRows, trashRows] = await Promise.all([getEntries(), getTrashEntries()]);

    let failedCount = 0;
    const liveHydrated = [];
    for (const row of liveRows) {
      try {
        liveHydrated.push(await hydrateEntryRow(row, false));
      } catch {
        failedCount += 1;
      }
    }
    const trashHydrated = [];
    for (const row of trashRows) {
      try {
        trashHydrated.push(await hydrateEntryRow(row, true));
      } catch {
        failedCount += 1;
      }
    }
    entriesCache = liveHydrated;
    trashCache = trashHydrated;
    session.failedCount = failedCount;
  })().finally(() => {
    loadPromise = null;
  });

  await loadPromise;
}

function toEntryPayload(entry) {
  return {
    ...normalizeEntryShape(entry),
    timestamp: new Date().toISOString(),
  };
}

async function bootstrapUMKIfNeeded() {
  const rootKey = ensureRootKey();
  const keys = await getKeys();
  const umkMeta = keys.find((k) => k.type === 'umk') || null;

  if (!umkMeta) {
    const rawUmk = generateEntryKey();
    const encryptedUmk = await encryptUMK(rawUmk, rootKey);
    const created = await addKey({
      key_id: randomId(),
      type: 'umk',
      label: null,
      encrypted_data: bytesToB64(encryptedUmk),
      peer_user_id: null,
    });
    umkKeyRecord = { key_id: created.key_id, type: 'umk', encrypted_data: bytesToB64(encryptedUmk) };
    umkBytes = rawUmk;
  } else {
    const full = await getKey(umkMeta.key_id);
    const decrypted = await decryptUMK(b64ToBytes(full.encrypted_data), rootKey);
    umkBytes = decrypted;
    umkKeyRecord = full;
  }

  // On first login, generate and upload an mlkem1024+x448 key pair.
  // own_public stores the raw public key bytes (unencrypted).
  // own_private stores the raw private key bytes encrypted with the UMK.
  const hasOwnPublic = keys.some((k) => k.type === 'own_public');
  if (!hasOwnPublic) {
    const currentUMK = ensureUMK();
    const { publicKeyRaw, privateKeyRaw } = await generateMlkem1024X448KeyPair();
    const encPriv = await encryptBlob(currentUMK, privateKeyRaw);
    await addKey({ key_id: randomId(), type: 'own_public', label: null, encrypted_data: bytesToB64(publicKeyRaw), peer_user_id: null });
    await addKey({ key_id: randomId(), type: 'own_private', label: null, encrypted_data: bytesToB64(encPriv), peer_user_id: null });
  }
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
    failedCount: 0,
  };

  userName = typeof config.username === 'string' ? config.username : '';
  entriesCache = [];
  trashCache = [];
  entryKeyById = new Map();
  vaultBlobSize = 0;
  await bootstrapUMKIfNeeded();

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
  zeroizeBytes(umkBytes);
  rootMasterKeyBytes = null;
  umkBytes = null;
  umkKeyRecord = null;
  session = null;
  entriesCache = [];
  trashCache = [];
  entryKeyById = new Map();
  userName = '';
  loadPromise = null;
  vaultBlobSize = 0;
}

export function buildExportData({ username, entries, trash }) {
  return {
    version: 1,
    username: typeof username === 'string' ? username : '',
    data: Array.isArray(entries) ? entries : [],
    trash: Array.isArray(trash) ? trash : [],
  };
}

export async function getEntries() {
  return requestJson('/entries');
}

export async function getTrashEntries() {
  return requestJson('/entries/trash');
}

export async function createEntry(data) {
  return requestJson('/entries', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updateEntry(id, data) {
  return requestJson(`/entries/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function deleteEntry(id) {
  return requestJson(`/entries/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function restoreEntry(id) {
  return requestJson(`/entries/${encodeURIComponent(id)}/restore`, { method: 'POST' });
}

export async function purgeEntry(id) {
  return requestJson(`/entries/${encodeURIComponent(id)}/purge`, { method: 'DELETE' });
}

export async function getHistory(id) {
  return requestJson(`/entries/${encodeURIComponent(id)}/history`);
}

export async function updateEntryKeyBlob(id, entryKeyB64) {
  return requestJson(`/entries/${encodeURIComponent(id)}/entry-key`, {
    method: 'PUT',
    body: JSON.stringify({ entry_key: entryKeyB64 }),
  });
}

export async function getKeys() {
  return requestJson('/keys');
}

export async function addKey(data) {
  return requestJson('/keys', { method: 'POST', body: JSON.stringify(data) });
}

export async function getKey(keyId) {
  return requestJson(`/keys/${encodeURIComponent(keyId)}`);
}

export async function deleteKey(keyId) {
  return requestJson(`/keys/${encodeURIComponent(keyId)}`, { method: 'DELETE' });
}

export async function updateKey(keyId, encrypted_data) {
  return requestJson(`/keys/${encodeURIComponent(keyId)}`, {
    method: 'PUT',
    body: JSON.stringify({ encrypted_data }),
  });
}

export async function getPeerPublicKey(userId) {
  return requestJson(`/users/${encodeURIComponent(userId)}/public-key`);
}

export async function listKeyStore() {
  const keys = await getKeys();
  return keys.slice().sort((a, b) => {
    if (a.type === b.type) return String(b.created_at).localeCompare(String(a.created_at));
    return String(a.type).localeCompare(String(b.type));
  });
}

export async function addEmergencyKey(label = null) {
  const root = ensureRootKey();
  const bytes = generateEntryKey();
  const encrypted = await encryptBlob(root, bytes);
  const payload = {
    key_id: randomId(),
    type: 'emergency',
    label: label ? String(label) : null,
    encrypted_data: bytesToB64(encrypted),
    peer_user_id: null,
  };
  return addKey(payload);
}

export async function regenerateOwnKeyPair() {
  const currentUMK = ensureUMK();
  const keys = await getKeys();
  const removable = keys.filter((k) => k.type === 'own_public' || k.type === 'own_private');
  for (const key of removable) {
    await deleteKey(key.key_id);
  }

  const { publicKeyRaw, privateKeyRaw } = await generateMlkem1024X448KeyPair();
  const encPriv = await encryptBlob(currentUMK, privateKeyRaw);

  await addKey({ key_id: randomId(), type: 'own_public', label: null, encrypted_data: bytesToB64(publicKeyRaw), peer_user_id: null });
  await addKey({ key_id: randomId(), type: 'own_private', label: null, encrypted_data: bytesToB64(encPriv), peer_user_id: null });
}

export async function fetchUserEntries() {
  await ensureVaultLoaded();
  return {
    entries: entriesCache.map((e) => ({ ...e })),
    trash: trashCache.map((e) => ({ ...e })),
    failedCount: session?.failedCount || 0,
  };
}

export async function createUserEntry(entry) {
  await ensureVaultLoaded();
  const currentUMK = ensureUMK();

  const payload = toEntryPayload(entry);
  const entryId = randomId();
  const historyId = randomId();
  const rawEntryKey = generateEntryKey();
  const entryKeyBlob = await encryptEntryKey(rawEntryKey, currentUMK);
  const entryBlob = await encryptEntry(payload, rawEntryKey);
  const snapshot = await buildSnapshotPayload(payload);
  const snapshotBlob = await encryptEntry(snapshot, rawEntryKey);

  const createdMeta = await createEntry({
    id: entryId,
    entry_key: bytesToB64(entryKeyBlob),
    encrypted_data: bytesToB64(entryBlob),
    history_id: historyId,
    encrypted_snapshot: bytesToB64(snapshotBlob),
  });

  entryKeyById.set(entryId, rawEntryKey);
  const commit = {
    hash: snapshot.commit_hash,
    parent: null,
    timestamp: createdMeta.created_at || payload.timestamp,
    changed: [],
    snapshot: normalizeEntryShape(snapshot),
  };
  const created = {
    id: entryId,
    ...normalizeEntryShape(payload),
    _commits: [commit],
    _entryMeta: {
      created_at: createdMeta.created_at || payload.timestamp,
      updated_at: createdMeta.created_at || payload.timestamp,
      deleted_at: null,
      entry_key_blob: bytesToB64(entryKeyBlob),
    },
  };
  entriesCache = [created, ...entriesCache];
  return created;
}

export async function updateUserEntry(entryId, entry) {
  await ensureVaultLoaded();
  const idx = entriesCache.findIndex((e) => e.id === entryId);
  if (idx < 0) throw new Error('Entry not found');

  const rawEntryKey = entryKeyById.get(entryId);
  if (!rawEntryKey) throw new Error('Entry key is unavailable');

  const payload = toEntryPayload(entry);
  const snapshot = await buildSnapshotPayload(payload);
  const entryBlob = await encryptEntry(payload, rawEntryKey);
  const snapshotBlob = await encryptEntry(snapshot, rawEntryKey);

  const meta = await updateEntry(entryId, {
    encrypted_data: bytesToB64(entryBlob),
    history_id: randomId(),
    encrypted_snapshot: bytesToB64(snapshotBlob),
  });

  const historyRows = await getHistory(entryId);
  const commits = await decodeHistorySnapshots(historyRows, rawEntryKey);
  const updated = {
    ...entriesCache[idx],
    ...normalizeEntryShape(payload),
    _commits: commits,
    _entryMeta: {
      ...entriesCache[idx]._entryMeta,
      updated_at: meta.updated_at || payload.timestamp,
    },
  };
  entriesCache = entriesCache.map((e, i) => (i === idx ? updated : e));
  return updated;
}

export async function restoreEntryVersion(entryId, commitHash) {
  await ensureVaultLoaded();
  const idx = entriesCache.findIndex((e) => e.id === entryId);
  if (idx < 0) throw new Error('Entry not found');
  const target = (entriesCache[idx]._commits || []).find((c) => c.hash === commitHash);
  if (!target) throw new Error('Commit not found');
  return updateUserEntry(entryId, target.snapshot);
}

export async function deleteUserEntry(entryId) {
  await ensureVaultLoaded();
  const idx = entriesCache.findIndex((e) => e.id === entryId);
  if (idx < 0) throw new Error('Entry not found');

  const meta = await deleteEntry(entryId);
  const source = entriesCache[idx];
  const trashed = { ...source, deletedAt: normalizeTimestamp(meta.deleted_at) };
  entriesCache = entriesCache.filter((e) => e.id !== entryId);
  trashCache = [trashed, ...trashCache.filter((e) => e.id !== entryId)];
  return trashed;
}

export async function restoreDeletedUserEntry(entryId) {
  await ensureVaultLoaded();
  const idx = trashCache.findIndex((e) => e.id === entryId);
  if (idx < 0) throw new Error('Deleted entry not found');
  await restoreEntry(entryId);
  const restored = { ...trashCache[idx] };
  delete restored.deletedAt;
  entriesCache = [restored, ...entriesCache.filter((e) => e.id !== entryId)];
  trashCache = trashCache.filter((e) => e.id !== entryId);
  return restored;
}

export async function restoreDeletedEntryVersion(entryId, commitHash) {
  await ensureVaultLoaded();
  const idx = trashCache.findIndex((e) => e.id === entryId);
  if (idx < 0) throw new Error('Deleted entry not found');
  const target = (trashCache[idx]._commits || []).find((c) => c.hash === commitHash);
  if (!target) throw new Error('Commit not found');
  await restoreDeletedUserEntry(entryId);
  return updateUserEntry(entryId, target.snapshot);
}

export async function permanentlyDeleteUserEntry(entryId) {
  await ensureVaultLoaded();
  const exists = trashCache.some((e) => e.id === entryId);
  if (!exists) throw new Error('Deleted entry not found');
  await purgeEntry(entryId);
  trashCache = trashCache.filter((e) => e.id !== entryId);
  entryKeyById.delete(entryId);
}

export async function rotateRootMasterKey(newRootMasterKeyBytes) {
  if (!(newRootMasterKeyBytes instanceof Uint8Array)) {
    throw new Error('New root master key must be bytes');
  }
  if (!umkKeyRecord?.key_id) throw new Error('UMK record missing');
  const oldRoot = ensureRootKey().slice();
  const currentUmk = ensureUMK().slice();

  const rewrapped = await encryptUMK(currentUmk, newRootMasterKeyBytes);
  await updateKey(umkKeyRecord.key_id, bytesToB64(rewrapped));

  zeroizeBytes(rootMasterKeyBytes);
  rootMasterKeyBytes = newRootMasterKeyBytes.slice();
  umkKeyRecord = { ...umkKeyRecord, encrypted_data: bytesToB64(rewrapped) };
  zeroizeBytes(oldRoot);
}

export async function rotateUserMasterKey() {
  const root = ensureRootKey();
  const oldUmk = ensureUMK();
  if (!umkKeyRecord?.key_id) throw new Error('UMK record missing');
  await ensureVaultLoaded();

  const allEntryIds = Array.from(new Set([
    ...entriesCache.map((e) => e.id),
    ...trashCache.map((e) => e.id),
  ]));
  const newUmk = generateEntryKey();
  const attempted = new Set();

  for (const entryId of allEntryIds) {
    const rawEntryKey = entryKeyById.get(entryId);
    if (!rawEntryKey) continue;
    const rewrappedBlob = await encryptEntryKey(rawEntryKey, newUmk);
    attempted.add(entryId);
    await updateEntryKeyBlob(entryId, bytesToB64(rewrappedBlob));
  }

  const newUmkBlob = await encryptUMK(newUmk, root);
  await updateKey(umkKeyRecord.key_id, bytesToB64(newUmkBlob));

  zeroizeBytes(umkBytes);
  umkBytes = newUmk;
  umkKeyRecord = { ...umkKeyRecord, encrypted_data: bytesToB64(newUmkBlob) };
  return { rotatedEntries: attempted.size };
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
  decodeHistorySnapshots,
};
