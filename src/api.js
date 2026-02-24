import {
  decryptEntryHistoryWithDocKey,
  encryptEntryHistoryWithDocKey,
  generateEntryDocKey,
  unwrapEntryKey,
  wrapEntryKey,
} from './crypto';

let workerUrl = null;
let firebaseApiKey = null;
let idToken = null;
let refreshToken = null;
let idTokenExp = 0;
let userMasterKeyBytes = null;
const MAX_COMMITS = 20;
const MAX_VALUE_BYTES = 1_900_000;
const TOKEN_REFRESH_SKEW_SECONDS = 300;

// ─── ID generation ────────────────────────────────────────────────────────────

const ID_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const ID_LEN = 42;

function generateId() {
  const arr = crypto.getRandomValues(new Uint8Array(ID_LEN));
  return Array.from(arr, b => ID_CHARS[b % ID_CHARS.length]).join('');
}

// ─── Binary helpers ───────────────────────────────────────────────────────────

function toB64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function fromB64(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toUint8Array(value) {
  if (value instanceof Uint8Array) return value;
  return null;
}

// ─── Size check ───────────────────────────────────────────────────────────────

function checkValueSize(value) {
  const bytes = toUint8Array(value);
  if (!bytes) throw new Error('Encrypted value must be bytes');
  if (bytes.length >= MAX_VALUE_BYTES) {
    throw new Error(
      `Entry data is too large (${Math.ceil(bytes.length / 1000)} KB). ` +
      `Maximum allowed is ${MAX_VALUE_BYTES / 1000} KB. Try reducing notes or removing attachments.`,
    );
  }
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

async function apiFetch(path, options = {}) {
  await ensureFreshIdToken();
  const headers = { 'Content-Type': 'application/json' };
  if (idToken) headers.Authorization = `Bearer ${idToken}`;
  const res = await fetch(`${workerUrl}${path}`, { ...options, headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

const apiGet = path => apiFetch(path, { method: 'GET' });
const apiPost = (path, body) => apiFetch(path, { method: 'POST', body: JSON.stringify(body) });
const apiPut = (path, body) => apiFetch(path, { method: 'PUT', body: JSON.stringify(body) });
const apiDelete = path => apiFetch(path, { method: 'DELETE' });

// ─── Public auth / session ────────────────────────────────────────────────────

function decodeJwtPayload(token) {
  const parts = token?.split('.');
  if (!parts || parts.length < 2) return null;
  const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  try {
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

function setIdTokenState(nextIdToken, nextRefreshToken = refreshToken) {
  idToken = nextIdToken;
  refreshToken = nextRefreshToken;
  const payload = decodeJwtPayload(nextIdToken);
  idTokenExp = Number(payload?.exp) || 0;
}

async function refreshIdTokenIfNeeded() {
  const now = Math.floor(Date.now() / 1000);
  if (!refreshToken || !idToken || idTokenExp - now > TOKEN_REFRESH_SKEW_SECONDS) {
    return;
  }

  const res = await fetch(
    `https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(firebaseApiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    },
  );
  if (!res.ok) {
    throw new Error('Failed to refresh Firebase token');
  }

  const data = await res.json();
  if (!data?.id_token || !data?.refresh_token) {
    throw new Error('Invalid Firebase refresh response');
  }
  setIdTokenState(data.id_token, data.refresh_token);
}

async function ensureFreshIdToken() {
  if (!idToken) throw new Error('Not authenticated');
  await refreshIdTokenIfNeeded();
}

export async function initApi(config) {
  workerUrl = config.worker_url.replace(/\/$/, '');
  firebaseApiKey = config.firebase_api_key;
  if (!firebaseApiKey) throw new Error('Missing required field: firebase_api_key');

  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(firebaseApiKey)}`,
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
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error?.message || 'Firebase authentication failed');
  }
  if (!data?.idToken || !data?.refreshToken || !data?.localId) {
    throw new Error('Invalid Firebase authentication response');
  }

  setIdTokenState(data.idToken, data.refreshToken);
  return { userId: data.localId };
}

function zeroizeBytes(bytes) {
  if (bytes instanceof Uint8Array) bytes.fill(0);
}

export function setUserMasterKey(keyBytes) {
  if (!(keyBytes instanceof Uint8Array)) {
    throw new Error('User master key must be bytes');
  }
  zeroizeBytes(userMasterKeyBytes);
  userMasterKeyBytes = keyBytes.slice();
}

export function getUserMasterKey() {
  return userMasterKeyBytes;
}

export function clearUserMasterKey() {
  zeroizeBytes(userMasterKeyBytes);
  userMasterKeyBytes = null;
  idToken = null;
  refreshToken = null;
  idTokenExp = 0;
  firebaseApiKey = null;
  workerUrl = null;
}

// ─── User profile ─────────────────────────────────────────────────────────────

export async function fetchUser() {
  const data = await apiGet('/me/profile');
  return {
    username: data.username,
    user_master_key: data.user_master_key ? fromB64(data.user_master_key) : null,
  };
}

export async function saveUserMasterKey(userMasterKeyBlob, username = undefined) {
  const bytes = toUint8Array(userMasterKeyBlob);
  if (!bytes) throw new Error('user_master_key must be bytes');
  await apiPost('/me/profile', {
    user_master_key: toB64(bytes),
    ...(typeof username === 'string' && username.trim() ? { username: username.trim() } : {}),
  });
}

// ─── Raw docs ─────────────────────────────────────────────────────────────────

export async function fetchRawUserDocs() {
  const entries = await apiGet('/entries');
  return entries.map(e => ({
    id: e.id,
    entry_key: fromB64(e.entry_key),
    value: fromB64(e.value),
  }));
}

// ─── Normalization helpers ────────────────────────────────────────────────────

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

function normalizeEntryShape(entry) {
  const safe = entry && typeof entry === 'object' ? entry : {};
  const customFields = normalizeCustomFields(
    Array.isArray(safe.customFields) ? safe.customFields : safe.hiddenFields,
  );
  const { hiddenFields, ...rest } = safe;
  return {
    ...rest,
    title: typeof safe.title === 'string' ? safe.title : '',
    username: typeof safe.username === 'string' ? safe.username : '',
    password: typeof safe.password === 'string' ? safe.password : '',
    notes: typeof safe.notes === 'string' ? safe.notes : '',
    timestamp: normalizeTimestamp(safe.timestamp),
    tags: normalizeTags(safe.tags),
    totpSecrets: normalizeTotpSecrets(safe.totpSecrets),
    customFields,
  };
}

function normalizeTimestamp(timestamp) {
  if (typeof timestamp === 'string') {
    const ms = Date.parse(timestamp);
    if (Number.isFinite(ms)) {
      return new Date(ms).toISOString();
    }
  }
  return new Date().toISOString();
}

function toEntryPayload(entry) {
  const { id, _placeholder, _isNew, _snapshots, _commits, ...payload } = entry || {};
  return {
    ...normalizeEntryShape(payload),
    timestamp: new Date().toISOString(),
  };
}

// ─── Commit-chain helpers ─────────────────────────────────────────────────────

async function contentHash(obj) {
  const stable = {};
  for (const k of Object.keys(obj).sort()) stable[k] = obj[k];
  const data = new TextEncoder().encode(JSON.stringify(stable));
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 12);
}

const TRACKED_FIELDS = ['title', 'username', 'password', 'notes', 'urls', 'totpSecrets', 'customFields', 'tags'];

function diffFields(prevSnapshot, nextSnapshot) {
  return TRACKED_FIELDS.filter(
    (f) => JSON.stringify(prevSnapshot?.[f]) !== JSON.stringify(nextSnapshot?.[f]),
  );
}

function normalizeChangedFields(changed) {
  if (!Array.isArray(changed)) return [];
  return changed.map((f) => (f === 'hiddenFields' ? 'customFields' : f));
}

function normalizeCommitMeta(commit) {
  return {
    hash: commit?.hash ?? null,
    parent: commit?.parent ?? null,
    timestamp: normalizeTimestamp(commit?.timestamp),
    changed: normalizeChangedFields(commit?.changed),
  };
}

function buildSnapshotDelta(previousSnapshot, nextSnapshot) {
  const prev = previousSnapshot && typeof previousSnapshot === 'object' ? previousSnapshot : {};
  const next = nextSnapshot && typeof nextSnapshot === 'object' ? nextSnapshot : {};

  const set = {};
  const unset = [];
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);

  for (const key of keys) {
    const prevHas = Object.prototype.hasOwnProperty.call(prev, key);
    const nextHas = Object.prototype.hasOwnProperty.call(next, key);
    if (!nextHas) {
      unset.push(key);
      continue;
    }
    if (!prevHas || JSON.stringify(prev[key]) !== JSON.stringify(next[key])) {
      set[key] = next[key];
    }
  }

  return { set, unset };
}

function applySnapshotDelta(previousSnapshot, delta) {
  const snapshot = {
    ...(previousSnapshot && typeof previousSnapshot === 'object' ? previousSnapshot : {}),
  };

  if (Array.isArray(delta?.unset)) {
    for (const key of delta.unset) {
      delete snapshot[key];
    }
  }

  if (delta?.set && typeof delta.set === 'object') {
    for (const [key, value] of Object.entries(delta.set)) {
      snapshot[key] = value;
    }
  }

  return normalizeEntryShape(snapshot);
}

function serializeHistoryForStorage(history) {
  const commits = Array.isArray(history?.commits) ? history.commits.slice(0, MAX_COMMITS) : [];
  if (commits.length === 0) {
    return { head: null, head_snapshot: null, commits: [] };
  }

  const snapshots = commits.map((c) => normalizeEntryShape(c?.snapshot));
  const compactCommits = commits.map((commit, index) => {
    const compact = normalizeCommitMeta(commit);
    if (index > 0) {
      compact.delta = buildSnapshotDelta(snapshots[index - 1], snapshots[index]);
    }
    return compact;
  });

  return {
    head: history?.head ?? compactCommits[0].hash ?? null,
    head_snapshot: snapshots[0],
    commits: compactCommits,
  };
}

function parseCompactHistory(parsed) {
  const rawCommits = parsed.commits
    .filter((c) => c && typeof c === 'object')
    .slice(0, MAX_COMMITS);
  if (!(parsed.head_snapshot && typeof parsed.head_snapshot === 'object') || rawCommits.length === 0) {
    return { head: parsed.head ?? null, commits: [] };
  }

  let currentSnapshot = normalizeEntryShape(parsed.head_snapshot);
  const commits = [];
  rawCommits.forEach((raw, index) => {
    const snapshot = index === 0
      ? currentSnapshot
      : applySnapshotDelta(currentSnapshot, raw.delta);
    currentSnapshot = snapshot;
    commits.push({
      ...normalizeCommitMeta(raw),
      snapshot,
    });
  });

  return { head: parsed.head ?? commits[0]?.hash ?? null, commits };
}

function parseHistoryJson(parsed) {
  if (!(parsed && typeof parsed === 'object' && Array.isArray(parsed.commits))) {
    return { head: null, commits: [] };
  }
  return parseCompactHistory(parsed);
}

async function decryptAndParseHistory(docKeyBytes, valueBytes) {
  const parsed = await decryptEntryHistoryWithDocKey(docKeyBytes, valueBytes);
  return parseHistoryJson(parsed);
}

async function parseEntryHistory(value, entryKeyBlob) {
  const valueBytes = toUint8Array(value);
  const entryKeyBytes = toUint8Array(entryKeyBlob);
  if (!valueBytes || !entryKeyBytes) return { head: null, commits: [] };
  if (!userMasterKeyBytes) {
    throw new Error('Entry master key is not initialized');
  }
  const docKeyBytes = await unwrapEntryKey(userMasterKeyBytes, entryKeyBytes);
  return decryptAndParseHistory(docKeyBytes, valueBytes);
}

async function buildNextHistory(existingHistory, payload) {
  const headCommit = existingHistory.commits[0] ?? null;

  const { timestamp, ...content } = payload;
  const hash = await contentHash(content);

  if (headCommit && headCommit.hash === hash) {
    return existingHistory;
  }

  const newCommit = {
    hash,
    parent: headCommit?.hash ?? null,
    timestamp: new Date().toISOString(),
    changed: headCommit ? diffFields(headCommit.snapshot, payload) : [],
    snapshot: payload,
  };

  const commits = [newCommit, ...existingHistory.commits].slice(0, MAX_COMMITS);
  return { head: hash, commits };
}

// ─── fetchUserEntries ─────────────────────────────────────────────────────────

export async function fetchUserEntries() {
  const docs = await fetchRawUserDocs();
  const entries = [];
  let failedCount = 0;
  for (const raw of docs) {
    try {
      const history = await parseEntryHistory(raw.value, raw.entry_key);
      if (history.commits.length === 0) continue;
      const latest = history.commits[0].snapshot;
      entries.push({ id: raw.id, ...normalizeEntryShape(latest), _commits: history.commits });
    } catch {
      failedCount++;
    }
  }
  return { entries, failedCount };
}

// ─── Public CRUD ──────────────────────────────────────────────────────────────

export async function createUserEntry(entry) {
  const payload = toEntryPayload(entry);
  if (!userMasterKeyBytes) {
    throw new Error('Entry master key is not initialized');
  }

  const docKeyBytes = generateEntryDocKey();
  const entryKeyBytes = await wrapEntryKey(userMasterKeyBytes, docKeyBytes);
  const history = await buildNextHistory({ head: null, commits: [] }, payload);
  const valueBytes = await encryptEntryHistoryWithDocKey(
    docKeyBytes, serializeHistoryForStorage(history),
  );
  checkValueSize(valueBytes);

  const id = generateId();
  await apiPost('/entries', {
    id,
    entry_key: toB64(entryKeyBytes),
    value: toB64(valueBytes),
  });
  return { id, ...history.commits[0].snapshot, _commits: history.commits };
}

export async function updateUserEntry(entryId, entry) {
  const payload = toEntryPayload(entry);
  if (!userMasterKeyBytes) {
    throw new Error('Entry master key is not initialized');
  }

  const existing = await apiGet(`/entries/${entryId}`).catch(() => null);
  const existingEntryKeyBytes = existing?.entry_key ? fromB64(existing.entry_key) : null;
  const existingValueBytes = existing?.value ? fromB64(existing.value) : null;

  const docKeyBytes = existingEntryKeyBytes
    ? await unwrapEntryKey(userMasterKeyBytes, existingEntryKeyBytes)
    : generateEntryDocKey();

  const existingHistory = existingEntryKeyBytes && existingValueBytes
    ? await decryptAndParseHistory(docKeyBytes, existingValueBytes)
    : { head: null, commits: [] };

  const history = await buildNextHistory(existingHistory, payload);

  const entryKeyBytes = existingEntryKeyBytes ?? await wrapEntryKey(userMasterKeyBytes, docKeyBytes);
  const valueBytes = await encryptEntryHistoryWithDocKey(
    docKeyBytes, serializeHistoryForStorage(history),
  );
  checkValueSize(valueBytes);

  await apiPut(`/entries/${entryId}`, {
    entry_key: toB64(entryKeyBytes),
    value: toB64(valueBytes),
  });

  const latestSnapshot = history.commits[0]?.snapshot ?? payload;
  return { id: String(entryId), ...latestSnapshot, _commits: history.commits };
}

export async function restoreEntryVersion(entryId, commitHash) {
  if (!userMasterKeyBytes) {
    throw new Error('Entry master key is not initialized');
  }

  const existing = await apiGet(`/entries/${entryId}`);
  if (!existing) throw new Error('Entry not found');

  const existingEntryKeyBytes = fromB64(existing.entry_key);
  const docKeyBytes = await unwrapEntryKey(userMasterKeyBytes, existingEntryKeyBytes);
  const existingValueBytes = fromB64(existing.value);
  const existingHistory = await decryptAndParseHistory(docKeyBytes, existingValueBytes);

  const targetCommit = existingHistory.commits.find((c) => c.hash === commitHash);
  if (!targetCommit) throw new Error(`Commit ${commitHash} not found`);

  const restoredPayload = { ...targetCommit.snapshot, timestamp: new Date().toISOString() };
  const history = await buildNextHistory(existingHistory, restoredPayload);

  const valueBytes = await encryptEntryHistoryWithDocKey(
    docKeyBytes, serializeHistoryForStorage(history),
  );
  checkValueSize(valueBytes);

  await apiPut(`/entries/${entryId}`, {
    entry_key: toB64(existingEntryKeyBytes),
    value: toB64(valueBytes),
  });

  const latestSnapshot = history.commits[0]?.snapshot ?? restoredPayload;
  return { id: String(entryId), ...latestSnapshot, _commits: history.commits };
}

export async function deleteUserEntry(entryId) {
  await apiDelete(`/entries/${entryId}`);
}

export const __historyFormatTestOnly = {
  applySnapshotDelta,
  buildSnapshotDelta,
  parseHistoryJson,
  serializeHistoryForStorage,
};
