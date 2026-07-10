import { init, id } from '@instantdb/react';
import schema from '../instant.schema';
import {
  b64ToBytes,
  bytesToB64,
  decryptBackupKey,
  decryptEntry,
  decryptEntryKey,
  decryptUMK,
  encryptBackupKey,
  encryptEntry,
  encryptEntryKey,
  encryptUMK,
  generateEntryKey,
  generateUMK,
  generateBackupKey,
} from './crypto';
import { computeCommitHash } from './lib/commitHash';

// History cap and trash retention: see docs/architecture.md, Maintenance.
// The cap (20) is decided (docs/features.md); the retention window is not,
// so TRASH_RETENTION_MS is a provisional placeholder, adjust here once fixed.
const HISTORY_CAP = 20;
const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, provisional

let db = null;
let rootMasterKeyBytes = null;
let umkBytes = null;
let backupKeyBytes = null;
let keyStoreId = null;
let usernameValue = null;
let backupDestinationsValue = { r2_config: null, s3_config: [] };

// Decrypted entryKey bytes, cached by entries row id, so hydrating the vault
// on every load/render doesn't require re-decrypting every entryKey blob.
const entryKeyCache = new Map();

function assertUnlocked() {
  if (!db) throw new Error('db not initialized; call initDb first');
  if (!umkBytes) throw new Error('Vault not unlocked; call ensureKeyStore first');
}

async function requireAuthId() {
  const auth = await db.getAuth();
  if (!auth) throw new Error('Not signed in');
  return auth.id;
}

// --- init / session ---------------------------------------------------------

export function initDb(instantAppId) {
  db = init({ appId: instantAppId, schema });
  return db;
}

export async function signIn({ email, password, firebaseApiKey, instantClientName }) {
  const { initializeApp, getApps } = await import('firebase/app');
  const { getAuth, signInWithEmailAndPassword } = await import('firebase/auth');

  const app = getApps().length ? getApps()[0] : initializeApp({ apiKey: firebaseApiKey });
  const firebaseAuth = getAuth(app);
  const credential = await signInWithEmailAndPassword(firebaseAuth, email, password);
  const idToken = await credential.user.getIdToken();
  await db.auth.signInWithIdToken({ idToken, clientName: instantClientName });
}

export async function getUserId() {
  return requireAuthId();
}

export function setUsername(name) {
  usernameValue = name;
}

export function getUsername() {
  return usernameValue;
}

export function setBackupDestinations({ r2_config, s3_config } = {}) {
  backupDestinationsValue = { r2_config: r2_config || null, s3_config: s3_config || [] };
}

export function getBackupDestinations() {
  return backupDestinationsValue;
}

export function clearSession() {
  rootMasterKeyBytes?.fill(0);
  umkBytes?.fill(0);
  backupKeyBytes?.fill(0);
  rootMasterKeyBytes = null;
  umkBytes = null;
  backupKeyBytes = null;
  keyStoreId = null;
  usernameValue = null;
  backupDestinationsValue = { r2_config: null, s3_config: [] };
  entryKeyCache.clear();
  return db?.auth.signOut();
}

// --- key bootstrap -----------------------------------------------------------

// Replaces the old bootstrapUMKIfNeeded, minus the ML-KEM/X448 sharing
// keypair bootstrap (sharing is deferred, see docs/features.md).
export async function ensureKeyStore(rmkBytes) {
  rootMasterKeyBytes = rmkBytes;
  await requireAuthId();

  let { keyStore: rows } = await db.queryOnce({ keyStore: {} });

  if (rows.length === 0) {
    // Reduce, not eliminate, the multi-tab/multi-device first run race
    // (see docs/security.md, Duplicate keyStore rows mitigation).
    await new Promise((resolve) => setTimeout(resolve, 200 + Math.random() * 300));
    ({ keyStore: rows } = await db.queryOnce({ keyStore: {} }));
  }

  if (rows.length > 1) {
    throw new Error(
      'Multiple keyStore rows found for this account. Refusing to guess which is correct; see docs/data_model.md, Uniqueness.',
    );
  }

  if (rows.length === 1) {
    const row = rows[0];
    umkBytes = await decryptUMK(b64ToBytes(row.umkBlob), rootMasterKeyBytes);
    backupKeyBytes = await decryptBackupKey(b64ToBytes(row.backupKeyBlob), rootMasterKeyBytes);
    keyStoreId = row.id;
    return;
  }

  const newUmk = generateUMK();
  const newBackupKey = generateBackupKey();
  const umkBlobBytes = await encryptUMK(newUmk, rootMasterKeyBytes);
  const backupBlobBytes = await encryptBackupKey(newBackupKey, rootMasterKeyBytes);
  const newId = id();
  const ownerId = await requireAuthId();

  await db.transact([
    db.tx.keyStore[newId]
      .update({
        umkBlob: bytesToB64(umkBlobBytes),
        backupKeyBlob: bytesToB64(backupBlobBytes),
      })
      .link({ owner: ownerId }),
  ]);

  umkBytes = newUmk;
  backupKeyBytes = newBackupKey;
  keyStoreId = newId;
}

// --- internal: entry key + history maintenance helpers -----------------------

async function getOrDecryptEntryKey(entriesRow) {
  if (entryKeyCache.has(entriesRow.id)) return entryKeyCache.get(entriesRow.id);
  const rawEntryKey = await decryptEntryKey(b64ToBytes(entriesRow.entryKey), umkBytes);
  entryKeyCache.set(entriesRow.id, rawEntryKey);
  return rawEntryKey;
}

async function pruneHistoryForEntry(entryId, rawEntryKey, historyRows) {
  if (historyRows.length <= HISTORY_CAP) return;
  const decorated = await Promise.all(
    historyRows.map(async (h) => ({
      id: h.id,
      snapshot: await decryptEntry(b64ToBytes(h.encryptedSnapshot), rawEntryKey),
    })),
  );
  decorated.sort((a, b) => (a.snapshot.updatedAt ?? a.snapshot.createdAt ?? 0) - (b.snapshot.updatedAt ?? b.snapshot.createdAt ?? 0));
  const toDelete = decorated.slice(0, decorated.length - HISTORY_CAP);
  if (toDelete.length === 0) return;
  await db.transact(toDelete.map((h) => db.tx.entryHistory[h.id].delete()));
}

async function purgeTrashRetention(trashEntries) {
  const now = Date.now();
  const expired = trashEntries.filter((e) => now - e.deletedAt > TRASH_RETENTION_MS);
  if (expired.length === 0) return;
  await db.transact(expired.map((e) => db.tx.entries[e.id].delete()));
  for (const e of expired) entryKeyCache.delete(e.id);
}

async function saveEntrySnapshot(entryId, rawEntryKey, snapshotWithoutHash, { isCreate, ownerId } = {}) {
  const commitHash = await computeCommitHash(snapshotWithoutHash);
  const withHash = { ...snapshotWithoutHash, commitHash };
  const dataBlob = await encryptEntry(withHash, rawEntryKey);
  const snapshotBlob = await encryptEntry(withHash, rawEntryKey);
  const historyId = id();

  const entriesChunk = isCreate
    ? db.tx.entries[entryId]
        .update({ entryKey: bytesToB64(await encryptEntryKey(rawEntryKey, umkBytes)), encryptedData: bytesToB64(dataBlob) })
        .link({ owner: ownerId })
    : db.tx.entries[entryId].update({ encryptedData: bytesToB64(dataBlob) });

  await db.transact([
    entriesChunk,
    db.tx.entryHistory[historyId].update({ encryptedSnapshot: bytesToB64(snapshotBlob) }).link({ entry: entryId }),
  ]);

  return { id: entryId, ...withHash, historyId };
}

// --- vault read ---------------------------------------------------------------

export async function fetchUserEntries() {
  assertUnlocked();
  await requireAuthId();

  const { entries: rows } = await db.queryOnce({ entries: { history: {} } });

  const entries = [];
  const trash = [];
  let failedCount = 0;

  for (const row of rows) {
    try {
      const rawEntryKey = await getOrDecryptEntryKey(row);
      const decoded = await decryptEntry(b64ToBytes(row.encryptedData), rawEntryKey);
      const historyRows = row.history || [];

      const history = await Promise.all(
        historyRows.map(async (h) => ({
          id: h.id,
          ...(await decryptEntry(b64ToBytes(h.encryptedSnapshot), rawEntryKey)),
        })),
      );
      history.sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0));

      const hydrated = { id: row.id, ...decoded, history };
      if (decoded.deletedAt) trash.push(hydrated);
      else entries.push(hydrated);

      await pruneHistoryForEntry(row.id, rawEntryKey, historyRows);
    } catch {
      // A single row failing to decrypt (wrong key, corrupted blob, planted
      // row) must not take down the whole vault load.
      failedCount += 1;
    }
  }

  await purgeTrashRetention(trash);

  return { entries, trash, failedCount };
}

// --- vault write ---------------------------------------------------------------

export async function createUserEntry(entry) {
  assertUnlocked();
  const ownerId = await requireAuthId();
  const now = Date.now();
  const entryId = id();
  const rawEntryKey = generateEntryKey();
  entryKeyCache.set(entryId, rawEntryKey);

  const snapshot = { ...entry, createdAt: now, updatedAt: now, deletedAt: null };
  return saveEntrySnapshot(entryId, rawEntryKey, snapshot, { isCreate: true, ownerId });
}

export async function updateUserEntry(entryId, entry) {
  assertUnlocked();
  const rawEntryKey = entryKeyCache.get(entryId);
  if (!rawEntryKey) throw new Error(`Unknown entry ${entryId}; call fetchUserEntries first`);
  const snapshot = { ...entry, updatedAt: Date.now() };
  return saveEntrySnapshot(entryId, rawEntryKey, snapshot);
}

export async function deleteUserEntry(entryId) {
  assertUnlocked();
  const rawEntryKey = entryKeyCache.get(entryId);
  if (!rawEntryKey) throw new Error(`Unknown entry ${entryId}; call fetchUserEntries first`);
  const { entries } = await db.queryOnce({ entries: { $: { where: { id: entryId } } } });
  const current = await decryptEntry(b64ToBytes(entries[0].encryptedData), rawEntryKey);
  const { commitHash: _drop, ...withoutHash } = current;
  return saveEntrySnapshot(entryId, rawEntryKey, { ...withoutHash, deletedAt: Date.now(), updatedAt: Date.now() });
}

export async function restoreDeletedUserEntry(entryId) {
  assertUnlocked();
  const rawEntryKey = entryKeyCache.get(entryId);
  if (!rawEntryKey) throw new Error(`Unknown entry ${entryId}; call fetchUserEntries first`);
  const { entries } = await db.queryOnce({ entries: { $: { where: { id: entryId } } } });
  const current = await decryptEntry(b64ToBytes(entries[0].encryptedData), rawEntryKey);
  const { commitHash: _drop, ...withoutHash } = current;
  return saveEntrySnapshot(entryId, rawEntryKey, { ...withoutHash, deletedAt: null, updatedAt: Date.now() });
}

async function restoreVersionByCommitHash(entryId, commitHash) {
  const rawEntryKey = entryKeyCache.get(entryId);
  if (!rawEntryKey) throw new Error(`Unknown entry ${entryId}; call fetchUserEntries first`);
  const { entryHistory: historyRows } = await db.queryOnce({
    entryHistory: { $: { where: { 'entry.id': entryId } } },
  });
  for (const h of historyRows) {
    const snapshot = await decryptEntry(b64ToBytes(h.encryptedSnapshot), rawEntryKey);
    if (snapshot.commitHash === commitHash) {
      const { commitHash: _drop, ...withoutHash } = snapshot;
      return saveEntrySnapshot(entryId, rawEntryKey, { ...withoutHash, updatedAt: Date.now() });
    }
  }
  throw new Error(`Commit ${commitHash} not found in history for entry ${entryId}`);
}

export async function restoreEntryVersion(entryId, commitHash) {
  assertUnlocked();
  return restoreVersionByCommitHash(entryId, commitHash);
}

export async function restoreDeletedEntryVersion(entryId, commitHash) {
  assertUnlocked();
  return restoreVersionByCommitHash(entryId, commitHash);
}

export async function permanentlyDeleteUserEntry(entryId) {
  assertUnlocked();
  // entryHistory rows cascade-delete automatically: onDelete: 'cascade' is
  // set on the entryHistoryEntry link in instant.schema.ts.
  await db.transact([db.tx.entries[entryId].delete()]);
  entryKeyCache.delete(entryId);
}

// --- key rotation ---------------------------------------------------------------

export async function rotateRootMasterKey(newRootMasterKeyBytes) {
  assertUnlocked();
  const newUmkBlob = await encryptUMK(umkBytes, newRootMasterKeyBytes);
  const newBackupBlob = await encryptBackupKey(backupKeyBytes, newRootMasterKeyBytes);
  await db.transact([
    db.tx.keyStore[keyStoreId].update({
      umkBlob: bytesToB64(newUmkBlob),
      backupKeyBlob: bytesToB64(newBackupBlob),
    }),
  ]);
  rootMasterKeyBytes = newRootMasterKeyBytes;
}

export async function rotateUserMasterKey() {
  assertUnlocked();
  const { entries: rows } = await db.queryOnce({ entries: {} });
  const newUmk = generateUMK();

  const rewrappedEntryKeys = await Promise.all(
    rows.map(async (row) => {
      const rawEntryKey = await getOrDecryptEntryKey(row);
      const newEntryKeyBlob = await encryptEntryKey(rawEntryKey, newUmk);
      return { rowId: row.id, blob: bytesToB64(newEntryKeyBlob) };
    }),
  );
  const newUmkBlob = await encryptUMK(newUmk, rootMasterKeyBytes);

  // Single atomic transaction: every entryKey rewrap plus the new keyStore
  // row together, so a failure anywhere leaves the old UMK and every old
  // entryKey blob fully valid (see docs/crypto.md, Key Rotation).
  await db.transact([
    ...rewrappedEntryKeys.map(({ rowId, blob }) => db.tx.entries[rowId].update({ entryKey: blob })),
    db.tx.keyStore[keyStoreId].update({ umkBlob: bytesToB64(newUmkBlob) }),
  ]);

  umkBytes = newUmk;
  return { rotatedEntries: rewrappedEntryKeys.length };
}

export async function rotateBackupKey() {
  assertUnlocked();
  const newBackupKey = generateBackupKey();
  const newBlob = await encryptBackupKey(newBackupKey, rootMasterKeyBytes);
  await db.transact([db.tx.keyStore[keyStoreId].update({ backupKeyBlob: bytesToB64(newBlob) })]);
  backupKeyBytes = newBackupKey;
}

export function getBackupKeyBytes() {
  return backupKeyBytes;
}

// --- stats / export ---------------------------------------------------------------

export function getVaultStats(entries, trash) {
  const tagCounts = new Map();
  for (const e of entries) {
    for (const t of e.tags || []) {
      tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
    }
  }
  return {
    entryCount: entries.length,
    trashCount: trash.length,
    tagCount: tagCounts.size,
  };
}

export function buildExportData({ username, entries, trash }) {
  return { version: 1, username, data: entries, trash };
}
