import { init, id, type InstantReactWebDatabase } from '@instantdb/react';
import schema, { type AppSchema } from '../instant.schema';
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
import { capHistoryArray, entryFilePath } from './lib/storage';
import type {
  BackupDestinations,
  Entry,
  EntryHistoryCommit,
  ExportData,
  ExportEntry,
  ExportHistoryCommit,
} from './types';

// History cap and trash retention: see docs/architecture.md, Maintenance.
// The cap (20) is decided (docs/features.md); the retention window is not,
// so TRASH_RETENTION_MS is a provisional placeholder, adjust here once fixed.
const HISTORY_CAP = 20;
const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, provisional

// Fields HistoryDiffModal knows how to diff; see its DIFF_FIELD_ORDER.
const DIFFABLE_FIELDS = [
  'title',
  'username',
  'password',
  'notes',
  'urls',
  'totpSecrets',
  'tags',
  'customFields',
] as const;

// A raw decrypted commit: an Entry's fields (minus `id`, which every commit
// in the array shares from the outer entries row and so is never itself
// stored per-commit -- see docs/crypto.md, Entry Data File), not yet wrapped
// into the {hash, timestamp, snapshot, ...} shape buildCommitList produces.
// `commitHash` is required, not optional like on `Entry`: every persisted
// commit always has one by construction.
type RawSnapshot = Omit<Entry, 'id' | 'commitHash'> & { commitHash: string };

// Exported (unlike most of this file's internals) purely so it's directly
// unit-testable: it's pure data logic with no dependency on InstantDB, see
// src/tests/db-pure.test.js.
export function fieldsChanged(fromSnap: Partial<Entry> | undefined, toSnap: Partial<Entry> | undefined): string[] {
  return DIFFABLE_FIELDS.filter((f) => JSON.stringify(fromSnap?.[f]) !== JSON.stringify(toSnap?.[f]));
}

// Defense in depth: saveEntrySnapshot always strips `history` before
// persisting a commit, so a stored commit should never carry a nested
// history field, but this runs again here at read time in case a future bug
// reintroduces one -- better to drop it than let it compound across saves
// (each save prepends the current entry, nested history and all, to the
// array). Exported for the same reason as fieldsChanged above.
export function stripNestedHistory(snap: RawSnapshot): Omit<RawSnapshot, 'history'> {
  const { history: _drop, ...rest } = snap;
  return rest;
}

// Builds the {hash, timestamp, snapshot, changed, parent} shape
// HistoryDiffModal and EntryDetail's version button expect, from the raw
// decrypted snapshots (already sorted newest first). Each commit's parent
// is the next, chronologically older, entry in the array; the oldest one
// has no parent and no `changed` list, shown as "initial version".
// Exported for the same reason as fieldsChanged above.
export function buildCommitList(sortedSnapshots: RawSnapshot[]): EntryHistoryCommit[] {
  return sortedSnapshots.map((snap, i) => {
    const parentSnap = sortedSnapshots[i + 1] || null;
    return {
      hash: snap.commitHash,
      timestamp: snap.updatedAt ?? snap.createdAt,
      snapshot: stripNestedHistory(snap) as Entry,
      parent: parentSnap ? parentSnap.commitHash : null,
      changed: parentSnap ? fieldsChanged(parentSnap, snap) : undefined,
    };
  });
}

let db: InstantReactWebDatabase<AppSchema> | null = null;
let rootMasterKeyBytes: Uint8Array | null = null;
let umkBytes: Uint8Array | null = null;
// Config only, never stored in InstantDB in any form: see
// decodeBackupMasterKey in crypto.ts for why.
let backupMasterKeyBytes: Uint8Array | null = null;
let umkStoreId: string | null = null;
let usernameValue: string | null = null;
let backupDestinationsValue: BackupDestinations = { r2_config: null, s3_config: [] };

// Decrypted entryKeyBlob bytes, cached by entries row id, so hydrating the
// vault on every load/render doesn't require re-decrypting every entryKeyBlob.
const entryKeyCache = new Map<string, Uint8Array>();

function assertUnlocked(): void {
  if (!db) throw new Error('db not initialized; call initDb first');
  if (!umkBytes) throw new Error('Vault not unlocked; call ensureKeyStore first');
}

async function requireAuthId(): Promise<string> {
  const auth = await db!.getAuth();
  if (!auth) throw new Error('Not signed in');
  return auth.id;
}

// --- init / session ---------------------------------------------------------

export function initDb(instantAppId: string): InstantReactWebDatabase<AppSchema> {
  // InstantDB shows its own floating dev tool icon (bottom-right on
  // localhost) unless explicitly disabled.
  db = init({ appId: instantAppId, schema, devtool: false });
  return db;
}

async function firebaseSignIn(email: string, password: string, firebaseApiKey: string) {
  const { initializeApp, getApps } = await import('firebase/app');
  const { getAuth, signInWithEmailAndPassword } = await import('firebase/auth');
  const app = getApps().length ? getApps()[0] : initializeApp({ apiKey: firebaseApiKey });
  return signInWithEmailAndPassword(getAuth(app), email, password);
}

// db.getAuth() reads back from a persisted store, not directly from the
// in-memory state signInWithIdToken() just updated, so there is a real
// window right after sign-in where it can return nothing yet. Wait for
// *some* auth to exist before trusting it elsewhere. Do not require its
// `email` to match: that field is optional on $users and may not be
// reliably populated even when the session is genuinely correct, so
// treating a missing/mismatched email as failure risks a false negative
// on a session that is actually fine; only warn on that, don't throw.
async function waitForSettledAuth(expectedEmail: string | null): Promise<void> {
  let auth = await db!.getAuth();
  for (let attempt = 0; !auth && attempt < 10; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    auth = await db!.getAuth();
  }
  if (!auth) {
    throw new Error('InstantDB auth did not settle after sign in; try again.');
  }
  if (auth.email && auth.email !== expectedEmail) {
    console.warn(`InstantDB auth settled to ${auth.email}, expected ${expectedEmail}; possible stale session.`);
  }
}

export interface SignInParams {
  email: string;
  password: string;
  firebaseApiKey: string;
  instantClientName: string;
}

export async function signIn({ email, password, firebaseApiKey, instantClientName }: SignInParams): Promise<void> {
  const credential = await firebaseSignIn(email, password, firebaseApiKey);
  const idToken = await credential.user.getIdToken();
  await db!.auth.signInWithIdToken({ idToken, clientName: instantClientName });
  await waitForSettledAuth(credential.user.email);
}

export async function getUserId(): Promise<string> {
  return requireAuthId();
}

export function setUsername(name: string): void {
  usernameValue = name;
}

export function getUsername(): string | null {
  return usernameValue;
}

export function setBackupDestinations({ r2_config, s3_config }: Partial<BackupDestinations> = {}): void {
  backupDestinationsValue = { r2_config: r2_config || null, s3_config: s3_config || [] };
}

export function getBackupDestinations(): BackupDestinations {
  return backupDestinationsValue;
}

export function setBackupMasterKey(bytes: Uint8Array | null): void {
  backupMasterKeyBytes = bytes;
}

export function getBackupMasterKeyBytes(): Uint8Array | null {
  return backupMasterKeyBytes;
}

export function clearSession() {
  rootMasterKeyBytes?.fill(0);
  umkBytes?.fill(0);
  backupMasterKeyBytes?.fill(0);
  rootMasterKeyBytes = null;
  umkBytes = null;
  backupMasterKeyBytes = null;
  umkStoreId = null;
  usernameValue = null;
  backupDestinationsValue = { r2_config: null, s3_config: [] };
  entryKeyCache.clear();
  return db?.auth.signOut();
}

// --- key bootstrap -----------------------------------------------------------

interface UmkStoreRow {
  id: string;
  umkBlob: string;
}

// Replaces the old bootstrapUMKIfNeeded, minus the ML-KEM/X448 sharing
// keypair bootstrap (sharing is deferred, see docs/features.md).
//
// umkStoreOwner is has: 'one' on both sides (see instant.schema.ts), so
// $users.umkStore is a single row or undefined here, not an array -- unlike
// keyStoreOwner's old has: 'many' workaround, there's no "more than one row"
// case left to defend against client side; the schema constraint is what's
// being trusted this time (see instant.schema.ts's own comment for why, and
// the fallback if it doesn't hold live).
async function queryOwnUmkStoreRow(authId: string): Promise<UmkStoreRow | null> {
  // Query from $users (whose id we already have directly) and follow the
  // forward link out to umkStore, rather than querying umkStore with a
  // reverse dot-path where filter (see docs/data_model.md, Uniqueness for
  // why: db.queryOnce()'s result is wrapped in a `data` key, e.g.
  // { data: { $users: [...] } }, not the bare query shape. Every queryOnce
  // call site in this file read the un-wrapped shape and so always saw
  // empty results, regardless of which query shape was tried.
  const users = (
    await db!.queryOnce({
      $users: { $: { where: { id: authId } }, umkStore: {} },
    })
  ).data.$users;
  return users[0]?.umkStore || null;
}

async function findOwnUmkStoreRow(authId: string): Promise<UmkStoreRow | null> {
  const row = await queryOwnUmkStoreRow(authId);
  if (row) return row;
  // Reduce, not eliminate, the multi-tab/multi-device first run race
  // (see docs/security.md, Duplicate umkStore rows mitigation).
  await new Promise((resolve) => setTimeout(resolve, 200 + Math.random() * 300));
  return queryOwnUmkStoreRow(authId);
}

async function createUmkStoreRow(): Promise<{ umk: Uint8Array; umkStoreId: string }> {
  const newUmk = generateUMK();
  const umkBlobBytes = await encryptUMK(newUmk, rootMasterKeyBytes!);
  const newId = id();
  const ownerId = await requireAuthId();

  await db!.transact([db!.tx.umkStore[newId].update({ umkBlob: bytesToB64(umkBlobBytes) }).link({ owner: ownerId })]);

  return { umk: newUmk, umkStoreId: newId };
}

export async function ensureKeyStore(rmkBytes: Uint8Array): Promise<void> {
  rootMasterKeyBytes = rmkBytes;
  const authId = await requireAuthId();
  const row = await findOwnUmkStoreRow(authId);

  if (row) {
    umkBytes = await decryptUMK(b64ToBytes(row.umkBlob), rootMasterKeyBytes);
    umkStoreId = row.id;
    return;
  }

  const created = await createUmkStoreRow();
  umkBytes = created.umk;
  umkStoreId = created.umkStoreId;
}

// --- internal: entry file storage helpers ------------------------------------

interface FileRef {
  id: string;
  url?: string;
}

interface EntriesRow {
  id: string;
  entryKeyBlob: string;
  entryFile?: FileRef;
}

async function getOrDecryptEntryKey(entriesRow: EntriesRow): Promise<Uint8Array> {
  const cached = entryKeyCache.get(entriesRow.id);
  if (cached) return cached;
  const rawEntryKey = await decryptEntryKey(b64ToBytes(entriesRow.entryKeyBlob), umkBytes!);
  entryKeyCache.set(entriesRow.id, rawEntryKey);
  return rawEntryKey;
}

// Uploads raw encrypted bytes directly to InstantDB Storage; no base64 step,
// Storage takes a File/Blob directly (see docs/crypto.md, Encryption
// Pipeline). Returns the new $files row's id, used to link it.
async function uploadEntryFile(path: string, bytes: Uint8Array): Promise<string> {
  const { data } = await db!.storage.uploadFile(path, new Blob([bytes as unknown as BlobPart]), {
    contentType: 'application/octet-stream',
  });
  return data.id;
}

// $files.url serves from files.instantdb.com, confirmed live -- see
// public/_headers' CSP connect-src and docs/tech_stack.md, CSP.
async function downloadEntryFile(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  return new Uint8Array(await res.arrayBuffer());
}

async function fetchCurrentEntryFile(entryId: string): Promise<FileRef | undefined> {
  const rows = (
    await db!.queryOnce({
      entries: { $: { where: { id: entryId } }, entryFile: {} },
    })
  ).data.entries;
  return rows[0]?.entryFile;
}

// The entry's whole history, newest first, decrypted from its one linked
// file. Empty when the entry has no file yet (a fresh create).
async function decryptHistoryArray(fileRef: FileRef | undefined, rawEntryKey: Uint8Array): Promise<RawSnapshot[]> {
  if (!fileRef) return [];
  if (!fileRef.url) throw new Error(`$files row ${fileRef.id} has no url yet`);
  const bytes = await downloadEntryFile(fileRef.url);
  return decryptEntry<RawSnapshot[]>(bytes, rawEntryKey);
}

interface TrashEntry {
  id: string;
  deletedAt: number;
}

async function purgeTrashRetention(trashEntries: TrashEntry[]): Promise<void> {
  const now = Date.now();
  const expired = trashEntries.filter((e) => now - e.deletedAt > TRASH_RETENTION_MS);
  if (expired.length === 0) return;
  await db!.transact(expired.map((e) => db!.tx.entries[e.id].delete()));
  for (const e of expired) entryKeyCache.delete(e.id);
}

interface SaveOptions {
  isCreate?: boolean;
}

// Decrypts the entry's current file (if it has one yet), prepends the new
// commit, and caps the result at HISTORY_CAP -- the whole cap enforcement
// happens here, in memory, once per save (see docs/crypto.md, Entry Data
// File, Cap enforcement), not as a separate pass over stored rows.
async function buildNewHistoryArray(
  entryId: string,
  rawEntryKey: Uint8Array,
  withHash: RawSnapshot,
  isCreate: boolean | undefined,
): Promise<{ array: RawSnapshot[]; oldFileId: string | undefined }> {
  const currentFile = isCreate ? undefined : await fetchCurrentEntryFile(entryId);
  const previous = await decryptHistoryArray(currentFile, rawEntryKey);
  return { array: capHistoryArray([withHash, ...previous], HISTORY_CAP), oldFileId: currentFile?.id };
}

// The single atomic swap every save ends in: delete the entry's previous
// file (if any) and link the new one, together in one db.transact call, so
// a crash between the two never leaves the entry linked to zero or two
// files (see docs/crypto.md, Entry Data File, Save). On create, the same
// call also writes entryKeyBlob and links umk to the user's own umkStore
// row -- the entries row's very first write must already set umk, or the
// entries update-permission check would fail on a row with no owner chain
// yet (see docs/data_model.md, Permission rules).
async function commitEntryFileSwap(
  entryId: string,
  rawEntryKey: Uint8Array,
  oldFileId: string | undefined,
  newFileId: string,
  { isCreate }: SaveOptions,
): Promise<void> {
  const ops = [];
  if (isCreate) {
    const entryKeyBlobB64 = bytesToB64(await encryptEntryKey(rawEntryKey, umkBytes!));
    ops.push(db!.tx.entries[entryId].update({ entryKeyBlob: entryKeyBlobB64 }).link({ umk: umkStoreId! }));
  }
  if (oldFileId) ops.push(db!.tx.$files[oldFileId].delete());
  ops.push(db!.tx.entries[entryId].link({ entryFile: newFileId }));
  await db!.transact(ops);
}

async function saveEntrySnapshot(
  entryId: string,
  rawEntryKey: Uint8Array,
  snapshotWithoutHash: Partial<Entry>,
  { isCreate }: SaveOptions = {},
): Promise<Entry> {
  // Defense in depth: every caller already strips `history` from its input,
  // but this is the one choke point all saves funnel through, so a future
  // caller forgetting to strip it can't reintroduce the self-nesting bug.
  const { history: _dropHistory, ...cleanSnapshot } = snapshotWithoutHash;
  const commitHash = await computeCommitHash(cleanSnapshot);
  const withHash = { ...cleanSnapshot, commitHash } as RawSnapshot;

  const { array, oldFileId } = await buildNewHistoryArray(entryId, rawEntryKey, withHash, isCreate);
  const authId = await requireAuthId();
  const bytes = await encryptEntry(array, rawEntryKey);
  const newFileId = await uploadEntryFile(entryFilePath(authId, entryId, commitHash), bytes);
  await commitEntryFileSwap(entryId, rawEntryKey, oldFileId, newFileId, { isCreate });

  // id must come after the spread, not before: withHash never carries the
  // real entryId (RawSnapshot omits `id` entirely, see above) and a stale
  // draft id on cleanSnapshot must not silently win over the real one.
  return { ...withHash, id: entryId, history: buildCommitList(array) } as Entry;
}

// --- vault read ---------------------------------------------------------------

async function hydrateEntryRow(row: EntriesRow): Promise<Entry> {
  const rawEntryKey = await getOrDecryptEntryKey(row);
  const array = await decryptHistoryArray(row.entryFile, rawEntryKey);
  if (array.length === 0) throw new Error(`Entry ${row.id} has no file content`);
  return { ...stripNestedHistory(array[0]), id: row.id, history: buildCommitList(array) };
}

export interface FetchUserEntriesResult {
  entries: Entry[];
  trash: Entry[];
  failedCount: number;
}

export async function fetchUserEntries(): Promise<FetchUserEntriesResult> {
  assertUnlocked();
  // Query the user's own umkStore row directly by its already-known id and
  // follow the forward link out to entries, same "query the root entity by
  // its own id, then follow the link out" shape as fetchCurrentEntryFile.
  const umkStoreRows = (
    await db!.queryOnce({
      umkStore: { $: { where: { id: umkStoreId! } }, entries: { entryFile: {} } },
    })
  ).data.umkStore;
  const rows: EntriesRow[] = umkStoreRows[0]?.entries || [];

  const entries: Entry[] = [];
  const trash: Entry[] = [];
  let failedCount = 0;

  for (const row of rows) {
    try {
      const hydrated = await hydrateEntryRow(row);
      if (hydrated.deletedAt) trash.push(hydrated);
      else entries.push(hydrated);
    } catch {
      // A single row failing to decrypt (wrong key, corrupted blob, planted
      // row) must not take down the whole vault load.
      failedCount += 1;
    }
  }

  await purgeTrashRetention(trash as unknown as TrashEntry[]);

  return { entries, trash, failedCount };
}

// --- vault write ---------------------------------------------------------------

export async function createUserEntry(entry: Partial<Entry>): Promise<Entry> {
  assertUnlocked();
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
  return saveEntrySnapshot(entryId, rawEntryKey, snapshot, { isCreate: true });
}

export async function updateUserEntry(entryId: string, entry: Partial<Entry>): Promise<Entry> {
  assertUnlocked();
  const rawEntryKey = entryKeyCache.get(entryId);
  if (!rawEntryKey) throw new Error(`Unknown entry ${entryId}; call fetchUserEntries first`);
  const { id: _draftId, _isNew: _draftFlag, history: _draftHistory, ...content } = entry;
  const snapshot = { ...content, updatedAt: Date.now() };
  return saveEntrySnapshot(entryId, rawEntryKey, snapshot);
}

// Shared by deleteUserEntry/restoreDeletedUserEntry/restoreVersionByCommitHash:
// the entry's current content, read from its one linked file rather than a
// cached copy, since these ops need the latest state to build on top of.
async function fetchCurrentEntryContent(entryId: string, rawEntryKey: Uint8Array): Promise<RawSnapshot> {
  const fileRef = await fetchCurrentEntryFile(entryId);
  const array = await decryptHistoryArray(fileRef, rawEntryKey);
  if (array.length === 0) throw new Error(`Entry ${entryId} not found`);
  return array[0];
}

export async function deleteUserEntry(entryId: string): Promise<Entry> {
  assertUnlocked();
  const rawEntryKey = entryKeyCache.get(entryId);
  if (!rawEntryKey) throw new Error(`Unknown entry ${entryId}; call fetchUserEntries first`);
  const current = await fetchCurrentEntryContent(entryId, rawEntryKey);
  const { commitHash: _drop, history: _drop2, ...withoutHash } = current;
  return saveEntrySnapshot(entryId, rawEntryKey, { ...withoutHash, deletedAt: Date.now(), updatedAt: Date.now() });
}

export async function restoreDeletedUserEntry(entryId: string): Promise<Entry> {
  assertUnlocked();
  const rawEntryKey = entryKeyCache.get(entryId);
  if (!rawEntryKey) throw new Error(`Unknown entry ${entryId}; call fetchUserEntries first`);
  const current = await fetchCurrentEntryContent(entryId, rawEntryKey);
  const { commitHash: _drop, history: _drop2, ...withoutHash } = current;
  return saveEntrySnapshot(entryId, rawEntryKey, { ...withoutHash, deletedAt: null, updatedAt: Date.now() });
}

async function restoreVersionByCommitHash(entryId: string, commitHash: string): Promise<Entry> {
  const rawEntryKey = entryKeyCache.get(entryId);
  if (!rawEntryKey) throw new Error(`Unknown entry ${entryId}; call fetchUserEntries first`);
  const fileRef = await fetchCurrentEntryFile(entryId);
  const array = await decryptHistoryArray(fileRef, rawEntryKey);
  const match = array.find((snap) => snap.commitHash === commitHash);
  if (!match) throw new Error(`Commit ${commitHash} not found in history for entry ${entryId}`);
  const { commitHash: _drop, history: _drop2, ...withoutHash } = match;
  return saveEntrySnapshot(entryId, rawEntryKey, { ...withoutHash, updatedAt: Date.now() });
}

export async function restoreEntryVersion(entryId: string, commitHash: string): Promise<Entry> {
  assertUnlocked();
  return restoreVersionByCommitHash(entryId, commitHash);
}

export async function restoreDeletedEntryVersion(entryId: string, commitHash: string): Promise<Entry> {
  assertUnlocked();
  return restoreVersionByCommitHash(entryId, commitHash);
}

export async function permanentlyDeleteUserEntry(entryId: string): Promise<void> {
  assertUnlocked();
  // The linked $files row cascade-deletes automatically: onDelete: 'cascade'
  // is set on the entryFileEntry link in instant.schema.ts.
  await db!.transact([db!.tx.entries[entryId].delete()]);
  entryKeyCache.delete(entryId);
}

// --- key rotation ---------------------------------------------------------------

export async function rotateRootMasterKey(newRootMasterKeyBytes: Uint8Array): Promise<void> {
  assertUnlocked();
  const newUmkBlob = await encryptUMK(umkBytes!, newRootMasterKeyBytes);
  await db!.transact([db!.tx.umkStore[umkStoreId!].update({ umkBlob: bytesToB64(newUmkBlob) })]);
  rootMasterKeyBytes = newRootMasterKeyBytes;
}

interface RewrappedEntryKey {
  rowId: string;
  blob: string;
}

async function rewrapEntryKeysUnderNewUmk(rows: EntriesRow[], newUmk: Uint8Array): Promise<RewrappedEntryKey[]> {
  return Promise.all(
    rows.map(async (row) => {
      const rawEntryKey = await getOrDecryptEntryKey(row);
      const newEntryKeyBlob = await encryptEntryKey(rawEntryKey, newUmk);
      return { rowId: row.id, blob: bytesToB64(newEntryKeyBlob) };
    }),
  );
}

export async function rotateUserMasterKey(): Promise<{ rotatedEntries: number }> {
  assertUnlocked();
  // Same "query the root entity by its own id, then follow the link out"
  // shape as fetchUserEntries.
  const umkStoreForRotation = (
    await db!.queryOnce({
      umkStore: { $: { where: { id: umkStoreId! } }, entries: {} },
    })
  ).data.umkStore;
  const rows: EntriesRow[] = umkStoreForRotation[0]?.entries || [];
  const newUmk = generateUMK();

  const rewrappedEntryKeys = await rewrapEntryKeysUnderNewUmk(rows, newUmk);
  const newUmkBlob = await encryptUMK(newUmk, rootMasterKeyBytes!);

  // Single atomic transaction: every entryKeyBlob rewrap plus the new
  // umkStore row together, so a failure anywhere leaves the old UMK and
  // every old entryKeyBlob fully valid (see docs/crypto.md, Key Rotation).
  await db!.transact([
    ...rewrappedEntryKeys.map(({ rowId, blob }) => db!.tx.entries[rowId].update({ entryKeyBlob: blob })),
    db!.tx.umkStore[umkStoreId!].update({ umkBlob: bytesToB64(newUmkBlob) }),
  ]);

  umkBytes = newUmk;
  return { rotatedEntries: rewrappedEntryKeys.length };
}

// --- stats / export ---------------------------------------------------------------

export interface VaultStats {
  entryCount: number;
  trashCount: number;
  tagCount: number;
}

export function getVaultStats(entries: Entry[], trash: Entry[]): VaultStats {
  const tagCounts = new Map<string, number>();
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

// Export's history entries are flattened, not the UI-facing nested-snapshot
// shape: EntryHistoryCommit.snapshot is a full Entry, which itself carries
// `id` and `commitHash` -- both already represented at the commit's own
// level (the entry's real id doesn't vary per commit, and `hash` already is
// commitHash), so re-encoding them a second time inside `snapshot` for every
// single commit is pure duplication in the exported JSON. Drop both and
// spread the rest of the snapshot's fields to the top level instead.
function toExportCommit(commit: EntryHistoryCommit): ExportHistoryCommit {
  const { id: _drop, commitHash: _drop2, history: _drop3, ...content } = commit.snapshot;
  return { ...content, hash: commit.hash, timestamp: commit.timestamp, parent: commit.parent, changed: commit.changed };
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
function toExportEntry(entry: Entry): ExportEntry {
  const rawEntryKey = entryKeyCache.get(entry.id);
  return {
    ...entry,
    entry_key: rawEntryKey ? bytesToB64(rawEntryKey) : null,
    history: (entry.history || []).filter((commit) => commit.hash !== entry.commitHash).map(toExportCommit),
  };
}

export interface BuildExportDataParams {
  username: string | null;
  entries: Entry[];
  trash: Entry[];
}

export function buildExportData({ username, entries, trash }: BuildExportDataParams): ExportData {
  return {
    version: 1,
    username,
    user_master_key: umkBytes ? bytesToB64(umkBytes) : null,
    data: entries.map(toExportEntry),
    trash: trash.map(toExportEntry),
  };
}
