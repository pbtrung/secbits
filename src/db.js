import { init, id } from '@instantdb/react';
import schema from '../instant.schema';
import {
  b64ToBytes,
  bytesToB64,
  decryptEntry,
  decryptEntryKey,
  decryptUMK,
  encryptEntry,
  encryptEntryKey,
  encryptUMK,
  generateEntryKey,
  generateUMK,
} from './crypto';
import { computeCommitHash } from './lib/commitHash';

// History cap and trash retention: see docs/architecture.md, Maintenance.
// The cap (20) is decided (docs/features.md); the retention window is not,
// so TRASH_RETENTION_MS is a provisional placeholder, adjust here once fixed.
const HISTORY_CAP = 20;
const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, provisional

// Fields HistoryDiffModal knows how to diff; see its DIFF_FIELD_ORDER.
const DIFFABLE_FIELDS = ['title', 'username', 'password', 'notes', 'urls', 'totpSecrets', 'tags', 'customFields'];

function fieldsChanged(fromSnap, toSnap) {
  return DIFFABLE_FIELDS.filter((f) => JSON.stringify(fromSnap?.[f]) !== JSON.stringify(toSnap?.[f]));
}

// Some entryHistory rows written before saveEntrySnapshot stripped `history`
// from its input still carry a nested history field in their decrypted
// snapshot forever (entryHistory rows are immutable, never rewritten), so
// this must be stripped again here at read time, not only at write time, or
// old rows go on looking nested no matter how many times they're re-saved.
function stripNestedHistory(snap) {
  const { history: _drop, ...rest } = snap;
  return rest;
}

// Builds the {hash, timestamp, snapshot, changed, parent} shape
// HistoryDiffModal and EntryDetail's version button expect, from the raw
// decrypted snapshots (already sorted newest first). Each commit's parent
// is the next, chronologically older, entry in the array; the oldest one
// has no parent and no `changed` list, shown as "initial version".
function buildCommitList(sortedSnapshots) {
  return sortedSnapshots.map((snap, i) => {
    const parentSnap = sortedSnapshots[i + 1] || null;
    return {
      id: snap.id,
      hash: snap.commitHash,
      timestamp: snap.updatedAt ?? snap.createdAt,
      snapshot: stripNestedHistory(snap),
      parent: parentSnap ? parentSnap.commitHash : null,
      changed: parentSnap ? fieldsChanged(parentSnap, snap) : undefined,
    };
  });
}

let db = null;
let rootMasterKeyBytes = null;
let umkBytes = null;
// Config only, never stored in InstantDB in any form: see
// decodeBackupMasterKey in crypto.js for why.
let backupMasterKeyBytes = null;
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
  // InstantDB shows its own floating dev tool icon (bottom-right on
  // localhost) unless explicitly disabled.
  db = init({ appId: instantAppId, schema, devtool: false });
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

  // db.getAuth() reads back from a persisted store, not directly from the
  // in-memory state signInWithIdToken() just updated, so there is a real
  // window right after sign-in where it can return nothing yet. Wait for
  // *some* auth to exist before trusting it elsewhere. Do not require its
  // `email` to match: that field is optional on $users and may not be
  // reliably populated even when the session is genuinely correct, so
  // treating a missing/mismatched email as failure risks a false negative
  // on a session that is actually fine; only warn on that, don't throw.
  const expectedEmail = credential.user.email;
  let auth = await db.getAuth();
  for (let attempt = 0; !auth && attempt < 10; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    auth = await db.getAuth();
  }
  if (!auth) {
    throw new Error('InstantDB auth did not settle after sign in; try again.');
  }
  if (auth.email && auth.email !== expectedEmail) {
    console.warn(`InstantDB auth settled to ${auth.email}, expected ${expectedEmail}; possible stale session.`);
  }
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

export function setBackupMasterKey(bytes) {
  backupMasterKeyBytes = bytes;
}

export function getBackupMasterKeyBytes() {
  return backupMasterKeyBytes;
}

export function clearSession() {
  rootMasterKeyBytes?.fill(0);
  umkBytes?.fill(0);
  backupMasterKeyBytes?.fill(0);
  rootMasterKeyBytes = null;
  umkBytes = null;
  backupMasterKeyBytes = null;
  keyStoreId = null;
  usernameValue = null;
  backupDestinationsValue = { r2_config: null, s3_config: [] };
  entryKeyCache.clear();
  return db?.auth.signOut();
}

// --- key bootstrap -----------------------------------------------------------

// Replaces the old bootstrapUMKIfNeeded, minus the ML-KEM/X448 sharing
// keypair bootstrap (sharing is deferred, see docs/features.md).
async function queryOwnKeyStoreRows(authId) {
  // Query from $users (whose id we already have directly) and follow the
  // forward link out to keyStore, rather than querying keyStore with a
  // reverse dot-path where filter (see docs/data_model.md, Uniqueness for
  // why: db.queryOnce()'s result is wrapped in a `data` key, e.g.
  // { data: { $users: [...] } }, not the bare query shape. Every queryOnce
  // call site in this file read the un-wrapped shape and so always saw
  // empty results, regardless of which query shape was tried.
  const users = (await db.queryOnce({
    $users: { $: { where: { id: authId } }, keyStore: {} },
  })).data.$users || [];
  return users[0]?.keyStore || [];
}

export async function ensureKeyStore(rmkBytes) {
  rootMasterKeyBytes = rmkBytes;
  const authId = await requireAuthId();

  let rows = await queryOwnKeyStoreRows(authId);

  if (rows.length === 0) {
    // Reduce, not eliminate, the multi-tab/multi-device first run race
    // (see docs/security.md, Duplicate keyStore rows mitigation).
    await new Promise((resolve) => setTimeout(resolve, 200 + Math.random() * 300));
    rows = await queryOwnKeyStoreRows(authId);
  }

  if (rows.length > 1) {
    throw new Error(
      'Multiple key store rows found for this account. Refusing to guess which is correct.',
    );
  }

  if (rows.length === 1) {
    const row = rows[0];
    umkBytes = await decryptUMK(b64ToBytes(row.umkBlob), rootMasterKeyBytes);
    keyStoreId = row.id;
    return;
  }

  const newUmk = generateUMK();
  const umkBlobBytes = await encryptUMK(newUmk, rootMasterKeyBytes);
  const newId = id();
  const ownerId = await requireAuthId();

  await db.transact([
    db.tx.keyStore[newId]
      .update({ umkBlob: bytesToB64(umkBlobBytes) })
      .link({ owner: ownerId }),
  ]);

  umkBytes = newUmk;
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
  // Defense in depth: every caller already strips `history` from its input,
  // but this is the one choke point all saves funnel through, so a future
  // caller forgetting to strip it can't reintroduce the self-nesting bug.
  const { history: _dropHistory, ...cleanSnapshot } = snapshotWithoutHash;
  const commitHash = await computeCommitHash(cleanSnapshot);
  const withHash = { ...cleanSnapshot, commitHash };
  // entries.encryptedData and entryHistory.encryptedSnapshot store the same
  // plaintext for this commit, so one encrypt call covers both; there's no
  // security reason to spend a second Brotli+AEAD pass re-encrypting
  // identical content under a second random salt.
  const blob = bytesToB64(await encryptEntry(withHash, rawEntryKey));
  const historyId = id();

  const entriesChunk = isCreate
    ? db.tx.entries[entryId]
        .update({ entryKey: bytesToB64(await encryptEntryKey(rawEntryKey, umkBytes)), encryptedData: blob })
        .link({ owner: ownerId })
    : db.tx.entries[entryId].update({ encryptedData: blob });

  await db.transact([
    entriesChunk,
    db.tx.entryHistory[historyId].update({ encryptedSnapshot: blob }).link({ entry: entryId }),
  ]);

  // Rebuild history the same way fetchUserEntries does, rather than
  // omitting it: every caller (create/update/restore) returns this result
  // straight to the UI, which replaces its in-memory entry with it. Without
  // this, `history` silently disappeared from the entry after every single
  // save, not just restore, since nothing here ever included it.
  const historyRows = (await db.queryOnce({
    entryHistory: { $: { where: { 'entry.id': entryId } } },
  })).data.entryHistory || [];
  const rawSnapshots = await Promise.all(
    historyRows.map(async (h) => ({
      id: h.id,
      ...(await decryptEntry(b64ToBytes(h.encryptedSnapshot), rawEntryKey)),
    })),
  );
  rawSnapshots.sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0));
  const history = buildCommitList(rawSnapshots);

  // id must come after the spread, not before: withHash can carry its own
  // stale `id` (e.g. the UI's local-<uuid> draft id, copied in via
  // createUserEntry's `...entry` spread), which would otherwise silently
  // win and get returned instead of the real entryId — exactly what caused
  // "edit an entry, save, and it creates a new entry instead of updating":
  // the UI kept holding the draft's local id after create, so the next
  // save looked like a new entry again.
  return { ...withHash, id: entryId, historyId, history };
}

// --- vault read ---------------------------------------------------------------

export async function fetchUserEntries() {
  assertUnlocked();
  const authId = await requireAuthId();

  // Same $users-first, follow-the-link approach as queryOwnKeyStoreRows.
  const users = (await db.queryOnce({
    $users: { $: { where: { id: authId } }, entries: { entryHistory: {} } },
  })).data.$users || [];
  const rows = users[0]?.entries || [];

  const entries = [];
  const trash = [];
  let failedCount = 0;

  for (const row of rows) {
    try {
      const rawEntryKey = await getOrDecryptEntryKey(row);
      const decoded = await decryptEntry(b64ToBytes(row.encryptedData), rawEntryKey);
      const historyRows = row.entryHistory || [];

      const rawSnapshots = await Promise.all(
        historyRows.map(async (h) => ({
          id: h.id,
          ...(await decryptEntry(b64ToBytes(h.encryptedSnapshot), rawEntryKey)),
        })),
      );
      rawSnapshots.sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0));
      const history = buildCommitList(rawSnapshots);

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

  // Strip the UI's local-only bookkeeping fields (draft id, _isNew flag,
  // and the hydrated history array saveEntrySnapshot attaches on read)
  // before they become part of the entry's actual content: they must not
  // end up inside the encrypted blob, the commit hash, or (see
  // saveEntrySnapshot) silently overwrite the real entryId in the result.
  // Letting `history` leak through here was the bug behind "history nests
  // inside itself on every save": each save re-embedded the UI's current
  // (already nested) history into the new snapshot, which then became part
  // of the next read's history too, growing without bound.
  const { id: _draftId, _isNew: _draftFlag, history: _draftHistory, ...content } = entry;
  const snapshot = { ...content, createdAt: now, updatedAt: now, deletedAt: null };
  return saveEntrySnapshot(entryId, rawEntryKey, snapshot, { isCreate: true, ownerId });
}

export async function updateUserEntry(entryId, entry) {
  assertUnlocked();
  const rawEntryKey = entryKeyCache.get(entryId);
  if (!rawEntryKey) throw new Error(`Unknown entry ${entryId}; call fetchUserEntries first`);
  const { id: _draftId, _isNew: _draftFlag, history: _draftHistory, ...content } = entry;
  const snapshot = { ...content, updatedAt: Date.now() };
  return saveEntrySnapshot(entryId, rawEntryKey, snapshot);
}

export async function deleteUserEntry(entryId) {
  assertUnlocked();
  const rawEntryKey = entryKeyCache.get(entryId);
  if (!rawEntryKey) throw new Error(`Unknown entry ${entryId}; call fetchUserEntries first`);
  const entries = (await db.queryOnce({ entries: { $: { where: { id: entryId } } } })).data.entries || [];
  if (!entries[0]) throw new Error(`Entry ${entryId} not found`);
  const current = await decryptEntry(b64ToBytes(entries[0].encryptedData), rawEntryKey);
  const { commitHash: _drop, history: _drop2, ...withoutHash } = current;
  return saveEntrySnapshot(entryId, rawEntryKey, { ...withoutHash, deletedAt: Date.now(), updatedAt: Date.now() });
}

export async function restoreDeletedUserEntry(entryId) {
  assertUnlocked();
  const rawEntryKey = entryKeyCache.get(entryId);
  if (!rawEntryKey) throw new Error(`Unknown entry ${entryId}; call fetchUserEntries first`);
  const entries = (await db.queryOnce({ entries: { $: { where: { id: entryId } } } })).data.entries || [];
  if (!entries[0]) throw new Error(`Entry ${entryId} not found`);
  const current = await decryptEntry(b64ToBytes(entries[0].encryptedData), rawEntryKey);
  const { commitHash: _drop, history: _drop2, ...withoutHash } = current;
  return saveEntrySnapshot(entryId, rawEntryKey, { ...withoutHash, deletedAt: null, updatedAt: Date.now() });
}

async function restoreVersionByCommitHash(entryId, commitHash) {
  const rawEntryKey = entryKeyCache.get(entryId);
  if (!rawEntryKey) throw new Error(`Unknown entry ${entryId}; call fetchUserEntries first`);
  const historyRows = (await db.queryOnce({
    entryHistory: { $: { where: { 'entry.id': entryId } } },
  })).data.entryHistory || [];
  for (const h of historyRows) {
    const snapshot = await decryptEntry(b64ToBytes(h.encryptedSnapshot), rawEntryKey);
    if (snapshot.commitHash === commitHash) {
      const { commitHash: _drop, history: _drop2, ...withoutHash } = snapshot;
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
  await db.transact([
    db.tx.keyStore[keyStoreId].update({ umkBlob: bytesToB64(newUmkBlob) }),
  ]);
  rootMasterKeyBytes = newRootMasterKeyBytes;
}

export async function rotateUserMasterKey() {
  assertUnlocked();
  const authId = await requireAuthId();
  const usersForRotation = (await db.queryOnce({
    $users: { $: { where: { id: authId } }, entries: {} },
  })).data.$users || [];
  const rows = usersForRotation[0]?.entries || [];
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

// Attaches each entry's raw entry_key only here, at export construction
// time, rather than as part of the hydrated entries fetchUserEntries()
// returns to the rest of the app: those objects live in React state for
// the whole session, and there's no reason for key material to sit there
// when only a backup needs it.
//
// entry.history includes the current version as its own newest entry (its
// HEAD, used by HistoryDiffModal/EntryDetail to badge it and to disable
// restoring "into itself"); a backup's per-entry history is redundant with
// the entry's own top-level fields for that same version, so it's dropped
// here rather than duplicated.
function toExportEntry(entry) {
  const rawEntryKey = entryKeyCache.get(entry.id);
  return {
    ...entry,
    entry_key: rawEntryKey ? bytesToB64(rawEntryKey) : null,
    history: (entry.history || []).filter((commit) => commit.hash !== entry.commitHash),
  };
}

export function buildExportData({ username, entries, trash }) {
  return {
    version: 1,
    username,
    user_master_key: umkBytes ? bytesToB64(umkBytes) : null,
    data: entries.map(toExportEntry),
    trash: trash.map(toExportEntry),
  };
}
