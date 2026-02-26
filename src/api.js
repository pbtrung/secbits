import { createDb } from './instantdb';
import {
  decryptEntryHistoryWithDocKey,
  encryptEntryHistoryWithDocKey,
  generateEntryDocKey,
  rewrapUserMasterKey,
  unwrapEntryKey,
  wrapEntryKey,
} from './crypto';

let db = null;
let userId = null;
let userMasterKeyBytes = null;
let rootMasterKeyBytes = null;
let backupTargets = [];
const MAX_COMMITS = 20;
const MAX_VALUE_BYTES = 1_900_000;

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

// ─── Public auth / session ────────────────────────────────────────────────────

export async function initApi(config) {
  backupTargets = Array.isArray(config.backup) ? config.backup.slice() : [];
  if (!config.firebase_api_key) throw new Error('Missing required field: firebase_api_key');
  if (!config.instant_app_id) throw new Error('Missing required field: instant_app_id');

  const res = await fetch(
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
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || 'Firebase authentication failed');
  if (!data?.idToken) throw new Error('Invalid Firebase authentication response');

  db = createDb(config.instant_app_id);
  const user = await db.auth.signInWithIdToken({ idToken: data.idToken, clientName: 'firebase' });
  userId = user.id;
  return { userId };
}

function zeroizeBytes(bytes) {
  if (bytes instanceof Uint8Array) bytes.fill(0);
}

export function setUserMasterKey(keyBytes) {
  if (!(keyBytes instanceof Uint8Array)) throw new Error('User master key must be bytes');
  zeroizeBytes(userMasterKeyBytes);
  userMasterKeyBytes = keyBytes.slice();
}

export function getUserMasterKey() {
  return userMasterKeyBytes;
}

export function setRootMasterKey(keyBytes) {
  if (!(keyBytes instanceof Uint8Array)) throw new Error('Root master key must be bytes');
  zeroizeBytes(rootMasterKeyBytes);
  rootMasterKeyBytes = keyBytes.slice();
}

export function getRootMasterKey() {
  return rootMasterKeyBytes;
}

export function getBackupTargets() {
  return backupTargets.slice();
}

export function clearUserMasterKey() {
  zeroizeBytes(userMasterKeyBytes);
  zeroizeBytes(rootMasterKeyBytes);
  userMasterKeyBytes = null;
  rootMasterKeyBytes = null;
  backupTargets = [];
  if (db) {
    db.auth.signOut().catch(() => {});
    db = null;
  }
  userId = null;
}

export async function rotateRootMasterKey(newRootMasterKeyBytes) {
  const currentUMK = getUserMasterKey();
  if (!currentUMK) throw new Error('Session key not available');
  const newBlob = await rewrapUserMasterKey(newRootMasterKeyBytes, currentUMK);
  await saveUserMasterKey(newBlob);
  setRootMasterKey(newRootMasterKeyBytes);
}

// ─── User profile ─────────────────────────────────────────────────────────────

export async function fetchUser() {
  const { data } = await db.queryOnce({ profiles: {} });
  const profile = data?.profiles?.[0] ?? null;
  if (!profile) return { username: null, user_master_key: null };
  return {
    username: profile.username ?? null,
    user_master_key: profile.user_master_key ? fromB64(profile.user_master_key) : null,
  };
}

export async function saveUserMasterKey(userMasterKeyBlob, username = undefined) {
  const bytes = toUint8Array(userMasterKeyBlob);
  if (!bytes) throw new Error('user_master_key must be bytes');
  const { data } = await db.queryOnce({ profiles: {} });
  const profileId = data?.profiles?.[0]?.id ?? db.id();
  await db.transact(
    db.tx.profiles[profileId]
      .update({
        user_master_key: toB64(bytes),
        ...(typeof username === 'string' && username.trim() ? { username: username.trim() } : {}),
      })
      .link({ $user: userId }),
  );
}

// ─── Raw docs ─────────────────────────────────────────────────────────────────

export async function fetchRawUserDocs() {
  const { data } = await db.queryOnce({ entries: {} });
  return (data?.entries ?? []).map(e => ({
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
  if (!userMasterKeyBytes) throw new Error('Entry master key is not initialized');

  const docKeyBytes = generateEntryDocKey();
  const entryKeyBytes = await wrapEntryKey(userMasterKeyBytes, docKeyBytes);
  const history = await buildNextHistory({ head: null, commits: [] }, payload);
  const valueBytes = await encryptEntryHistoryWithDocKey(
    docKeyBytes, serializeHistoryForStorage(history),
  );
  checkValueSize(valueBytes);

  const entryId = db.id();
  await db.transact(
    db.tx.entries[entryId]
      .update({ entry_key: toB64(entryKeyBytes), value: toB64(valueBytes) })
      .link({ $user: userId }),
  );
  return { id: entryId, ...history.commits[0].snapshot, _commits: history.commits };
}

export async function updateUserEntry(entryId, entry) {
  const payload = toEntryPayload(entry);
  if (!userMasterKeyBytes) throw new Error('Entry master key is not initialized');

  const { data } = await db.queryOnce({ entries: {} });
  const existing = data?.entries?.find(e => e.id === entryId) ?? null;
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

  await db.transact(
    db.tx.entries[entryId].update({ entry_key: toB64(entryKeyBytes), value: toB64(valueBytes) }),
  );
  return { id: entryId, ...(history.commits[0]?.snapshot ?? payload), _commits: history.commits };
}

export async function restoreEntryVersion(entryId, commitHash) {
  if (!userMasterKeyBytes) throw new Error('Entry master key is not initialized');

  const { data } = await db.queryOnce({ entries: {} });
  const existing = data?.entries?.find(e => e.id === entryId);
  if (!existing) throw new Error('Entry not found');

  const existingEntryKeyBytes = fromB64(existing.entry_key);
  const docKeyBytes = await unwrapEntryKey(userMasterKeyBytes, existingEntryKeyBytes);
  const existingHistory = await decryptAndParseHistory(docKeyBytes, fromB64(existing.value));

  const targetCommit = existingHistory.commits.find((c) => c.hash === commitHash);
  if (!targetCommit) throw new Error(`Commit ${commitHash} not found`);

  const restoredPayload = { ...targetCommit.snapshot, timestamp: new Date().toISOString() };
  const history = await buildNextHistory(existingHistory, restoredPayload);
  const valueBytes = await encryptEntryHistoryWithDocKey(
    docKeyBytes, serializeHistoryForStorage(history),
  );
  checkValueSize(valueBytes);

  await db.transact(
    db.tx.entries[entryId].update({ entry_key: toB64(existingEntryKeyBytes), value: toB64(valueBytes) }),
  );
  return { id: entryId, ...(history.commits[0]?.snapshot ?? restoredPayload), _commits: history.commits };
}

export async function deleteUserEntry(entryId) {
  await db.transact(db.tx.entries[entryId].delete());
}

export async function replaceUserEntries(rawEntries) {
  if (!Array.isArray(rawEntries)) throw new Error('rawEntries must be an array');
  const { data } = await db.queryOnce({ entries: {} });
  const existingEntries = data?.entries ?? [];
  await db.transact([
    ...existingEntries.map(e => db.tx.entries[e.id].delete()),
    ...rawEntries.map(e =>
      db.tx.entries[db.id()]
        .update({
          entry_key: typeof e.entry_key === 'string' ? e.entry_key : toB64(e.entry_key),
          value: typeof e.value === 'string' ? e.value : toB64(e.value),
        })
        .link({ $user: userId }),
    ),
  ]);
}

export const __historyFormatTestOnly = {
  applySnapshotDelta,
  buildSnapshotDelta,
  parseHistoryJson,
  serializeHistoryForStorage,
};
