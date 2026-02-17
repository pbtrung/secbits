import { initializeApp } from 'firebase/app';
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
} from 'firebase/firestore';
import { getAuth, signInAnonymously } from 'firebase/auth';
import {
  decryptEntrySnapshotsWithDocKey,
  encryptEntrySnapshotsWithDocKey,
  generateEntryDocKey,
  unwrapEntryDocKey,
  wrapEntryDocKey,
} from './crypto';

let app = null;
let db = null;
let auth = null;
let entryMasterKeyBytes = null;
const MAX_ENTRY_HISTORY = 5;
const MAX_VALUE_BYTES = 999999;

function checkValueSize(value) {
  const size = new TextEncoder().encode(value).length;
  if (size > MAX_VALUE_BYTES) {
    throw new Error(`Entry data is too large (${Math.ceil(size / 1000)} KB). Maximum allowed is ${MAX_VALUE_BYTES / 1000} KB. Try reducing notes or removing attachments.`);
  }
}

export function initFirebase(config, dbName) {
  app = initializeApp(config);
  db = dbName ? getFirestore(app, dbName) : getFirestore(app);
  auth = getAuth(app);
  return app;
}

export async function signIn() {
  await signInAnonymously(auth);
}

export function setEntryMasterKey(masterKeyBytes) {
  entryMasterKeyBytes = masterKeyBytes;
}

export async function fetchUser(userId) {
  const docRef = doc(db, 'users', String(userId));
  const snap = await getDoc(docRef);
  if (!snap.exists()) return null;
  return snap.data();
}

export async function saveUserMasterKey(userId, masterKeyBlob) {
  const docRef = doc(db, 'users', String(userId));
  await updateDoc(docRef, { master_key: masterKeyBlob });
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
  for (const d of snap.docs) {
    const raw = d.data();

    if (raw._placeholder) continue;

    const snapshots = await parseEntrySnapshots(raw.value, raw.enc_key);
    if (snapshots.length > 0) {
      const latest = snapshots[0];
      entries.push({ id: d.id, ...normalizeEntryShape(latest), _snapshots: snapshots });
      continue;
    }

    // Backward compatibility for legacy documents that stored entry fields directly.
    entries.push({ id: d.id, ...normalizeEntryShape(raw) });
  }
  return entries;
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

function normalizeHiddenFields(hiddenFields) {
  if (!Array.isArray(hiddenFields)) return [];
  return hiddenFields.map((field, index) => ({
    id: typeof field?.id === 'number' ? field.id : index + 1,
    // Keep secret label/value explicitly in JSON value payload.
    label: typeof field?.label === 'string' ? field.label : '',
    value: typeof field?.value === 'string' ? field.value : '',
  }));
}

function normalizeTotpSecrets(totpSecrets) {
  if (!Array.isArray(totpSecrets)) return [];
  return totpSecrets.map((secret) => String(secret ?? '')).filter((secret) => secret.length > 0);
}

function normalizeEntryShape(entry) {
  const safe = entry && typeof entry === 'object' ? entry : {};
  return {
    ...safe,
    timestamp: normalizeTimestamp(safe.timestamp),
    tags: normalizeTags(safe.tags),
    totpSecrets: normalizeTotpSecrets(safe.totpSecrets),
    hiddenFields: normalizeHiddenFields(safe.hiddenFields),
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
  const { id, _placeholder, _isNew, ...payload } = entry || {};
  return {
    ...normalizeEntryShape(payload),
    timestamp: new Date().toISOString(),
  };
}

async function parseEntrySnapshots(value, encKeyB64) {
  if (typeof value !== 'string') return [];

  if (typeof encKeyB64 === 'string') {
    if (!entryMasterKeyBytes) {
      throw new Error('Entry master key is not initialized');
    }

    // Strict mode for encrypted docs: unwrap/decrypt must pass HMAC verification.
    const docKeyBytes = unwrapEntryDocKey(entryMasterKeyBytes, encKeyB64);
    const decrypted = await decryptEntrySnapshotsWithDocKey(docKeyBytes, value);
    return decrypted
      .filter((item) => item && typeof item === 'object')
      .map((item) => normalizeEntryShape(item))
      .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
      .slice(0, MAX_ENTRY_HISTORY);
  }

  try {
    const parsed = JSON.parse(value);

    // Current format: JSON array of entry snapshots.
    if (Array.isArray(parsed)) {
      return parsed
        .filter((item) => item && typeof item === 'object')
        .map((item) => normalizeEntryShape(item))
        .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
        .slice(0, MAX_ENTRY_HISTORY);
    }

    // Legacy transitional format: single JSON object.
    if (parsed && typeof parsed === 'object') {
      return [normalizeEntryShape(parsed)];
    }
  } catch {
    // Ignore invalid JSON and let callers fall back to legacy shape.
  }

  return [];
}

async function toSnapshotsJson(existingValue, existingEncKey, nextPayload) {
  const existing = await parseEntrySnapshots(existingValue, existingEncKey);
  const snapshots = [nextPayload, ...existing]
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
    .slice(0, MAX_ENTRY_HISTORY);

  if (!entryMasterKeyBytes) {
    throw new Error('Entry master key is not initialized');
  }

  if (typeof existingEncKey === 'string') {
    const docKeyBytes = unwrapEntryDocKey(entryMasterKeyBytes, existingEncKey);
    return {
      enc_key: existingEncKey,
      value: await encryptEntrySnapshotsWithDocKey(docKeyBytes, snapshots),
    };
  }

  const docKeyBytes = generateEntryDocKey();
  return {
    enc_key: wrapEntryDocKey(entryMasterKeyBytes, docKeyBytes),
    value: await encryptEntrySnapshotsWithDocKey(docKeyBytes, snapshots),
  };
}

export async function createUserEntry(userId, entry) {
  const payload = toEntryPayload(entry);
  const colRef = collection(db, 'users', String(userId), 'data');
  if (!entryMasterKeyBytes) {
    throw new Error('Entry master key is not initialized');
  }
  const docKeyBytes = generateEntryDocKey();
  const enc_key = wrapEntryDocKey(entryMasterKeyBytes, docKeyBytes);
  const value = await encryptEntrySnapshotsWithDocKey(docKeyBytes, [payload]);
  checkValueSize(value);
  const created = await addDoc(colRef, { enc_key, value });
  return { id: created.id, ...payload, _snapshots: [payload] };
}

export async function updateUserEntry(userId, entryId, entry) {
  const payload = toEntryPayload(entry);
  const docRef = doc(db, 'users', String(userId), 'data', String(entryId));
  const snap = await getDoc(docRef);
  const existingValue = snap.exists() ? snap.data()?.value : null;
  const existingEncKey = snap.exists() ? snap.data()?.enc_key : null;
  const existing = await parseEntrySnapshots(existingValue, existingEncKey);
  const allSnapshots = [payload, ...existing]
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
    .slice(0, MAX_ENTRY_HISTORY);
  const nextData = await toSnapshotsJson(existingValue, existingEncKey, payload);
  checkValueSize(nextData.value);
  await updateDoc(docRef, nextData);
  return { id: String(entryId), ...payload, _snapshots: allSnapshots };
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
