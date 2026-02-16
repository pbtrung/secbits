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

let app = null;
let db = null;
let auth = null;

export function initFirebase(config, dbName) {
  app = initializeApp(config);
  db = dbName ? getFirestore(app, dbName) : getFirestore(app);
  auth = getAuth(app);
  return app;
}

export async function signIn() {
  await signInAnonymously(auth);
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

export async function fetchUserEntries(userId) {
  const colRef = collection(db, 'users', String(userId), 'data');
  const snap = await getDocs(colRef);
  const entries = [];
  snap.forEach((d) => {
    const raw = d.data();

    if (raw._placeholder) return;

    if (typeof raw.value === 'string') {
      try {
        const parsed = JSON.parse(raw.value);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          entries.push({ id: d.id, ...normalizeEntryShape(parsed) });
          return;
        }
      } catch {
        // Ignore invalid JSON payloads and fall back to legacy shape.
      }
    }

    // Backward compatibility for legacy documents that stored entry fields directly.
    entries.push({ id: d.id, ...normalizeEntryShape(raw) });
  });
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

function normalizeEntryShape(entry) {
  const safe = entry && typeof entry === 'object' ? entry : {};
  return {
    ...safe,
    tags: normalizeTags(safe.tags),
    hiddenFields: normalizeHiddenFields(safe.hiddenFields),
  };
}

function toEntryPayload(entry) {
  const { id, _placeholder, _isNew, ...payload } = entry || {};
  return normalizeEntryShape(payload);
}

export async function createUserEntry(userId, entry) {
  const payload = toEntryPayload(entry);
  const colRef = collection(db, 'users', String(userId), 'data');
  const created = await addDoc(colRef, { value: JSON.stringify(payload) });
  return { id: created.id, ...payload };
}

export async function updateUserEntry(userId, entryId, entry) {
  const payload = toEntryPayload(entry);
  const docRef = doc(db, 'users', String(userId), 'data', String(entryId));
  await updateDoc(docRef, { value: JSON.stringify(payload) });
  return { id: String(entryId), ...payload };
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
