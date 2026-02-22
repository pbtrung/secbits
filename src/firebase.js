import { initializeApp, deleteApp } from 'firebase/app';
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  collection,
  getDocs,
  addDoc,
  deleteDoc,
  Bytes,
} from 'firebase/firestore';
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth';
import {
  decryptEntryHistoryWithDocKey,
  encryptEntryHistoryWithDocKey,
  generateEntryDocKey,
  unwrapEntryKey,
  wrapEntryKey,
} from './crypto';

let app = null;
let db = null;
let auth = null;
let userMasterKeyBytes = null;
const MAX_COMMITS = 10;
const MAX_VALUE_BYTES = 999999;

function checkValueSize(value) {
  const size = getStoredValueSize(value);
  if (size > MAX_VALUE_BYTES) {
    throw new Error(`Entry data is too large (${Math.ceil(size / 1000)} KB). Maximum allowed is ${MAX_VALUE_BYTES / 1000} KB. Try reducing notes or removing attachments.`);
  }
}

function toUint8Array(value) {
  if (value instanceof Uint8Array) return value;
  if (value && typeof value.toUint8Array === 'function') return value.toUint8Array();
  return null;
}

function getStoredValueSize(value) {
  const bytes = toUint8Array(value);
  if (!bytes) throw new Error('Stored value must be bytes');
  return bytes.length;
}

function toFirestoreBytes(value) {
  const bytes = toUint8Array(value);
  if (!bytes) throw new Error('Encrypted value must be bytes');
  return Bytes.fromUint8Array(bytes);
}

export async function initFirebase(config, dbName) {
  if (app) {
    await deleteApp(app);
    app = null;
  }
  app = initializeApp(config);
  db = dbName ? getFirestore(app, dbName) : getFirestore(app);
  auth = getAuth(app);
  return app;
}

export async function signIn(email, password) {
  const cred = await signInWithEmailAndPassword(auth, email, password);
  return cred.user.uid;
}

function zeroizeBytes(bytes) {
  if (bytes instanceof Uint8Array) {
    bytes.fill(0);
  }
}

export function setUserMasterKey(keyBytes) {
  if (!(keyBytes instanceof Uint8Array)) {
    throw new Error('User master key must be bytes');
  }
  zeroizeBytes(userMasterKeyBytes);
  // Keep an internal copy so callers can clear their local buffer.
  userMasterKeyBytes = keyBytes.slice();
}

export function getUserMasterKey() {
  return userMasterKeyBytes;
}

export function clearUserMasterKey() {
  zeroizeBytes(userMasterKeyBytes);
  userMasterKeyBytes = null;
}

export async function fetchUser(userId) {
  const docRef = doc(db, 'users', String(userId));
  const snap = await getDoc(docRef);
  if (!snap.exists()) return null;
  return snap.data();
}

export async function saveUserMasterKey(userId, userMasterKeyBlob) {
  const docRef = doc(db, 'users', String(userId));
  await updateDoc(docRef, { user_master_key: toFirestoreBytes(userMasterKeyBlob) });
}

export async function fetchRawUserDocs(userId) {
  const colRef = collection(db, 'users', String(userId), 'data');
  const snap = await getDocs(colRef);
  const docs = [];
  snap.forEach((d) => {
    const raw = d.data();
    if (raw._placeholder) return;
    docs.push({ id: d.id, ...raw });
  });
  return docs;
}

export async function fetchUserEntries(userId) {
  const colRef = collection(db, 'users', String(userId), 'data');
  const snap = await getDocs(colRef);
  const entries = [];
  let failedCount = 0;
  for (const d of snap.docs) {
    const raw = d.data();

    if (raw._placeholder) continue;

    try {
      const history = await parseEntryHistory(raw.value, raw.entry_key);
      if (history.commits.length === 0) continue;
      const latest = history.commits[0].snapshot;
      entries.push({ id: d.id, ...normalizeEntryShape(latest), _commits: history.commits });
    } catch {
      failedCount++;
    }
  }
  return { entries, failedCount };
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

function normalizeEntryShape(entry) {
  const safe = entry && typeof entry === 'object' ? entry : {};
  const customFields = normalizeCustomFields(
    Array.isArray(safe.customFields) ? safe.customFields : safe.hiddenFields
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

// Stable SHA-256 hash of an object; top-level keys sorted for determinism.
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
    (f) => JSON.stringify(prevSnapshot?.[f]) !== JSON.stringify(nextSnapshot?.[f])
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

// Normalise raw decrypted JSON into a { head, commits } history object.
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

// Append a new commit to the history.
// Returns the same history object unchanged if the content didn't change
// (deduplication: hash of content without timestamp vs HEAD hash).
async function buildNextHistory(existingHistory, payload) {
  const headCommit = existingHistory.commits[0] ?? null;

  // Content hash excludes timestamp so saves with unchanged data are ignored.
  const { timestamp, ...content } = payload;
  const hash = await contentHash(content);

  if (headCommit && headCommit.hash === hash) {
    return existingHistory; // nothing changed — no new commit
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

// ─── Public CRUD ─────────────────────────────────────────────────────────────

export async function createUserEntry(userId, entry) {
  const payload = toEntryPayload(entry);
  if (!userMasterKeyBytes) {
    throw new Error('Entry master key is not initialized');
  }

  const docKeyBytes = generateEntryDocKey();
  const entry_key = toFirestoreBytes(await wrapEntryKey(userMasterKeyBytes, docKeyBytes));
  const history = await buildNextHistory({ head: null, commits: [] }, payload);
  const value = toFirestoreBytes(
    await encryptEntryHistoryWithDocKey(docKeyBytes, serializeHistoryForStorage(history))
  );
  checkValueSize(value);

  const colRef = collection(db, 'users', String(userId), 'data');
  const created = await addDoc(colRef, { entry_key, value });
  return { id: created.id, ...history.commits[0].snapshot, _commits: history.commits };
}

export async function updateUserEntry(userId, entryId, entry) {
  const payload = toEntryPayload(entry);
  if (!userMasterKeyBytes) {
    throw new Error('Entry master key is not initialized');
  }

  const docRef = doc(db, 'users', String(userId), 'data', String(entryId));
  const snap = await getDoc(docRef);
  const existingEntryKeyRaw = snap.exists() ? snap.data()?.entry_key : null;
  const existingValueRaw = snap.exists() ? snap.data()?.value : null;

  // Unwrap the doc key once; reuse for both decryption and encryption.
  const existingEntryKeyBytes = toUint8Array(existingEntryKeyRaw);
  const docKeyBytes = existingEntryKeyBytes
    ? await unwrapEntryKey(userMasterKeyBytes, existingEntryKeyBytes)
    : generateEntryDocKey();

  const existingValueBytes = toUint8Array(existingValueRaw);
  const existingHistory =
    existingEntryKeyBytes && existingValueBytes
      ? await decryptAndParseHistory(docKeyBytes, existingValueBytes)
      : { head: null, commits: [] };

  const history = await buildNextHistory(existingHistory, payload);

  const entry_key = existingEntryKeyBytes
    ? toFirestoreBytes(existingEntryKeyBytes)
    : toFirestoreBytes(await wrapEntryKey(userMasterKeyBytes, docKeyBytes));

  const value = toFirestoreBytes(
    await encryptEntryHistoryWithDocKey(docKeyBytes, serializeHistoryForStorage(history))
  );
  checkValueSize(value);
  await updateDoc(docRef, { entry_key, value });

  const latestSnapshot = history.commits[0]?.snapshot ?? payload;
  return { id: String(entryId), ...latestSnapshot, _commits: history.commits };
}

// Restore an old commit by creating a new HEAD commit with its content.
// Non-destructive: history is extended, not overwritten.
export async function restoreEntryVersion(userId, entryId, commitHash) {
  if (!userMasterKeyBytes) {
    throw new Error('Entry master key is not initialized');
  }

  const docRef = doc(db, 'users', String(userId), 'data', String(entryId));
  const snap = await getDoc(docRef);
  if (!snap.exists()) throw new Error('Entry not found');

  const existingEntryKeyBytes = toUint8Array(snap.data()?.entry_key);
  if (!existingEntryKeyBytes) throw new Error('No entry key found');

  const docKeyBytes = await unwrapEntryKey(userMasterKeyBytes, existingEntryKeyBytes);
  const existingValueBytes = toUint8Array(snap.data()?.value);
  const existingHistory = existingValueBytes
    ? await decryptAndParseHistory(docKeyBytes, existingValueBytes)
    : { head: null, commits: [] };

  const targetCommit = existingHistory.commits.find((c) => c.hash === commitHash);
  if (!targetCommit) throw new Error(`Commit ${commitHash} not found`);

  // Re-save old content as a new commit (timestamp updates, everything else identical).
  const restoredPayload = { ...targetCommit.snapshot, timestamp: new Date().toISOString() };
  const history = await buildNextHistory(existingHistory, restoredPayload);

  const entry_key = toFirestoreBytes(existingEntryKeyBytes);
  const value = toFirestoreBytes(
    await encryptEntryHistoryWithDocKey(docKeyBytes, serializeHistoryForStorage(history))
  );
  checkValueSize(value);
  await updateDoc(docRef, { entry_key, value });

  const latestSnapshot = history.commits[0]?.snapshot ?? restoredPayload;
  return { id: String(entryId), ...latestSnapshot, _commits: history.commits };
}

export async function deleteUserEntry(userId, entryId) {
  const docRef = doc(db, 'users', String(userId), 'data', String(entryId));
  await deleteDoc(docRef);
}

export async function initUserDataCollection(userId) {
  const colRef = collection(db, 'users', String(userId), 'data');
  const snap = await getDocs(colRef);
  if (snap.empty) {
    const placeholderRef = doc(db, 'users', String(userId), 'data', '_init');
    await setDoc(placeholderRef, { _placeholder: true });
  }
}

export const __historyFormatTestOnly = {
  applySnapshotDelta,
  buildSnapshotDelta,
  parseHistoryJson,
  serializeHistoryForStorage,
};
