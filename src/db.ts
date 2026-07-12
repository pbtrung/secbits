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
import type { BackupDestinations, Entry, EntryHistoryCommit, ExportData, ExportEntry } from './types';

// What's actually inside an encrypted entry/snapshot blob: `id` is never
// part of it, since it's always stripped before encryption (see
// createUserEntry/updateUserEntry) and reattached from the InstantDB row's
// own id afterward.
type EntryContent = Omit<Entry, 'id'>;

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

// A raw decrypted snapshot: an Entry's fields, but not yet wrapped into the
// {hash, timestamp, snapshot, ...} commit shape buildCommitList produces.
type RawSnapshot = Entry & { id: string };

// Exported (unlike most of this file's internals) purely so it's directly
// unit-testable: it's pure data logic with no dependency on InstantDB, see
// src/tests/db-pure.test.js.
export function fieldsChanged(fromSnap: Partial<Entry> | undefined, toSnap: Partial<Entry> | undefined): string[] {
  return DIFFABLE_FIELDS.filter((f) => JSON.stringify(fromSnap?.[f]) !== JSON.stringify(toSnap?.[f]));
}

// Some entryHistory rows written before saveEntrySnapshot stripped `history`
// from its input still carry a nested history field in their decrypted
// snapshot forever (entryHistory rows are immutable, never rewritten), so
// this must be stripped again here at read time, not only at write time, or
// old rows go on looking nested no matter how many times they're re-saved.
// Exported for the same reason as fieldsChanged above.
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
      id: snap.id,
      hash: snap.commitHash as string,
      timestamp: snap.updatedAt ?? snap.createdAt,
      snapshot: stripNestedHistory(snap) as Entry,
      parent: parentSnap ? (parentSnap.commitHash as string) : null,
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
let keyStoreId: string | null = null;
let usernameValue: string | null = null;
let backupDestinationsValue: BackupDestinations = { r2_config: null, s3_config: [] };

// Decrypted entryKey bytes, cached by entries row id, so hydrating the vault
// on every load/render doesn't require re-decrypting every entryKey blob.
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
  keyStoreId = null;
  usernameValue = null;
  backupDestinationsValue = { r2_config: null, s3_config: [] };
  entryKeyCache.clear();
  return db?.auth.signOut();
}

// --- key bootstrap -----------------------------------------------------------

interface KeyStoreRow {
  id: string;
  umkBlob: string;
}

// Replaces the old bootstrapUMKIfNeeded, minus the ML-KEM/X448 sharing
// keypair bootstrap (sharing is deferred, see docs/features.md).
async function queryOwnKeyStoreRows(authId: string): Promise<KeyStoreRow[]> {
  // Query from $users (whose id we already have directly) and follow the
  // forward link out to keyStore, rather than querying keyStore with a
  // reverse dot-path where filter (see docs/data_model.md, Uniqueness for
  // why: db.queryOnce()'s result is wrapped in a `data` key, e.g.
  // { data: { $users: [...] } }, not the bare query shape. Every queryOnce
  // call site in this file read the un-wrapped shape and so always saw
  // empty results, regardless of which query shape was tried.
  const users = (
    await db!.queryOnce({
      $users: { $: { where: { id: authId } }, keyStore: {} },
    })
  ).data.$users;
  return users[0]?.keyStore || [];
}

async function findOwnKeyStoreRow(authId: string): Promise<KeyStoreRow | null> {
  let rows = await queryOwnKeyStoreRows(authId);

  if (rows.length === 0) {
    // Reduce, not eliminate, the multi-tab/multi-device first run race
    // (see docs/security.md, Duplicate keyStore rows mitigation).
    await new Promise((resolve) => setTimeout(resolve, 200 + Math.random() * 300));
    rows = await queryOwnKeyStoreRows(authId);
  }

  if (rows.length > 1) {
    throw new Error('Multiple key store rows found for this account. Refusing to guess which is correct.');
  }
  return rows[0] || null;
}

async function createKeyStoreRow(): Promise<{ umk: Uint8Array; keyStoreId: string }> {
  const newUmk = generateUMK();
  const umkBlobBytes = await encryptUMK(newUmk, rootMasterKeyBytes!);
  const newId = id();
  const ownerId = await requireAuthId();

  await db!.transact([db!.tx.keyStore[newId].update({ umkBlob: bytesToB64(umkBlobBytes) }).link({ owner: ownerId })]);

  return { umk: newUmk, keyStoreId: newId };
}

export async function ensureKeyStore(rmkBytes: Uint8Array): Promise<void> {
  rootMasterKeyBytes = rmkBytes;
  const authId = await requireAuthId();
  const row = await findOwnKeyStoreRow(authId);

  if (row) {
    umkBytes = await decryptUMK(b64ToBytes(row.umkBlob), rootMasterKeyBytes);
    keyStoreId = row.id;
    return;
  }

  const created = await createKeyStoreRow();
  umkBytes = created.umk;
  keyStoreId = created.keyStoreId;
}

// --- internal: entry key + history maintenance helpers -----------------------

interface EntriesRow {
  id: string;
  entryKey: string;
  encryptedData: string;
}

async function getOrDecryptEntryKey(entriesRow: EntriesRow): Promise<Uint8Array> {
  const cached = entryKeyCache.get(entriesRow.id);
  if (cached) return cached;
  const rawEntryKey = await decryptEntryKey(b64ToBytes(entriesRow.entryKey), umkBytes!);
  entryKeyCache.set(entriesRow.id, rawEntryKey);
  return rawEntryKey;
}

interface EntryHistoryRow {
  id: string;
  encryptedSnapshot: string;
}

async function pruneHistoryForEntry(rawEntryKey: Uint8Array, historyRows: EntryHistoryRow[]): Promise<void> {
  if (historyRows.length <= HISTORY_CAP) return;
  const decorated = await Promise.all(
    historyRows.map(async (h) => ({
      id: h.id,
      snapshot: await decryptEntry<EntryContent>(b64ToBytes(h.encryptedSnapshot), rawEntryKey),
    })),
  );
  decorated.sort(
    (a, b) => (a.snapshot.updatedAt ?? a.snapshot.createdAt ?? 0) - (b.snapshot.updatedAt ?? b.snapshot.createdAt ?? 0),
  );
  const toDelete = decorated.slice(0, decorated.length - HISTORY_CAP);
  if (toDelete.length === 0) return;
  await db!.transact(toDelete.map((h) => db!.tx.entryHistory[h.id].delete()));
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

async function fetchEntryHistoryRows(entryId: string): Promise<EntryHistoryRow[]> {
  return (
    await db!.queryOnce({
      entryHistory: { $: { where: { 'entry.id': entryId } } },
    })
  ).data.entryHistory;
}

// Shared by fetchUserEntries and saveEntrySnapshot: decrypt every history
// row's snapshot and sort newest first, ready for buildCommitList.
async function decryptHistoryRows(historyRows: EntryHistoryRow[], rawEntryKey: Uint8Array): Promise<RawSnapshot[]> {
  const rawSnapshots = await Promise.all(
    historyRows.map(async (h) => ({
      id: h.id,
      ...(await decryptEntry<EntryContent>(b64ToBytes(h.encryptedSnapshot), rawEntryKey)),
    })),
  );
  rawSnapshots.sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0));
  return rawSnapshots;
}

// Rebuild history the same way fetchUserEntries does, rather than omitting
// it: every saveEntrySnapshot caller (create/update/restore) returns this
// result straight to the UI, which replaces its in-memory entry with it.
// Without this, `history` silently disappeared from the entry after every
// single save, not just restore, since nothing here ever included it.
async function rebuildEntryHistory(entryId: string, rawEntryKey: Uint8Array): Promise<EntryHistoryCommit[]> {
  const historyRows = await fetchEntryHistoryRows(entryId);
  const rawSnapshots = await decryptHistoryRows(historyRows, rawEntryKey);
  return buildCommitList(rawSnapshots);
}

interface SaveOptions {
  isCreate?: boolean;
  ownerId?: string;
}

async function buildEntriesTxChunk(
  entryId: string,
  rawEntryKey: Uint8Array,
  blob: string,
  { isCreate, ownerId }: SaveOptions,
) {
  if (!isCreate) return db!.tx.entries[entryId].update({ encryptedData: blob });
  const entryKeyBlob = bytesToB64(await encryptEntryKey(rawEntryKey, umkBytes!));
  return db!.tx.entries[entryId].update({ entryKey: entryKeyBlob, encryptedData: blob }).link({ owner: ownerId! });
}

async function saveEntrySnapshot(
  entryId: string,
  rawEntryKey: Uint8Array,
  snapshotWithoutHash: Partial<Entry>,
  { isCreate, ownerId }: SaveOptions = {},
): Promise<Entry> {
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
  const entriesChunk = await buildEntriesTxChunk(entryId, rawEntryKey, blob, { isCreate, ownerId });

  await db!.transact([
    entriesChunk,
    db!.tx.entryHistory[historyId].update({ encryptedSnapshot: blob }).link({ entry: entryId }),
  ]);

  const history = await rebuildEntryHistory(entryId, rawEntryKey);

  // id must come after the spread, not before: withHash can carry its own
  // stale `id` (e.g. the UI's local-<uuid> draft id, copied in via
  // createUserEntry's `...entry` spread), which would otherwise silently
  // win and get returned instead of the real entryId — exactly what caused
  // "edit an entry, save, and it creates a new entry instead of updating":
  // the UI kept holding the draft's local id after create, so the next
  // save looked like a new entry again.
  return { ...withHash, id: entryId, historyId, history } as Entry;
}

// --- vault read ---------------------------------------------------------------

interface EntriesRowWithHistory extends EntriesRow {
  entryHistory?: EntryHistoryRow[];
}

async function hydrateEntryRow(row: EntriesRowWithHistory): Promise<Entry> {
  const rawEntryKey = await getOrDecryptEntryKey(row);
  const decoded = await decryptEntry<EntryContent>(b64ToBytes(row.encryptedData), rawEntryKey);
  const historyRows = row.entryHistory || [];
  const rawSnapshots = await decryptHistoryRows(historyRows, rawEntryKey);
  const history = buildCommitList(rawSnapshots);
  await pruneHistoryForEntry(rawEntryKey, historyRows);
  return { id: row.id, ...decoded, history };
}

export interface FetchUserEntriesResult {
  entries: Entry[];
  trash: Entry[];
  failedCount: number;
}

export async function fetchUserEntries(): Promise<FetchUserEntriesResult> {
  assertUnlocked();
  const authId = await requireAuthId();
  // Same $users-first, follow-the-link approach as queryOwnKeyStoreRows.
  const users = (
    await db!.queryOnce({
      $users: { $: { where: { id: authId } }, entries: { entryHistory: {} } },
    })
  ).data.$users;
  const rows: EntriesRowWithHistory[] = users[0]?.entries || [];

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

export async function updateUserEntry(entryId: string, entry: Partial<Entry>): Promise<Entry> {
  assertUnlocked();
  const rawEntryKey = entryKeyCache.get(entryId);
  if (!rawEntryKey) throw new Error(`Unknown entry ${entryId}; call fetchUserEntries first`);
  const { id: _draftId, _isNew: _draftFlag, history: _draftHistory, ...content } = entry;
  const snapshot = { ...content, updatedAt: Date.now() };
  return saveEntrySnapshot(entryId, rawEntryKey, snapshot);
}

export async function deleteUserEntry(entryId: string): Promise<Entry> {
  assertUnlocked();
  const rawEntryKey = entryKeyCache.get(entryId);
  if (!rawEntryKey) throw new Error(`Unknown entry ${entryId}; call fetchUserEntries first`);
  const entries = (await db!.queryOnce({ entries: { $: { where: { id: entryId } } } })).data.entries;
  if (!entries[0]) throw new Error(`Entry ${entryId} not found`);
  const current = await decryptEntry<EntryContent>(b64ToBytes(entries[0].encryptedData), rawEntryKey);
  const { commitHash: _drop, history: _drop2, ...withoutHash } = current;
  return saveEntrySnapshot(entryId, rawEntryKey, { ...withoutHash, deletedAt: Date.now(), updatedAt: Date.now() });
}

export async function restoreDeletedUserEntry(entryId: string): Promise<Entry> {
  assertUnlocked();
  const rawEntryKey = entryKeyCache.get(entryId);
  if (!rawEntryKey) throw new Error(`Unknown entry ${entryId}; call fetchUserEntries first`);
  const entries = (await db!.queryOnce({ entries: { $: { where: { id: entryId } } } })).data.entries;
  if (!entries[0]) throw new Error(`Entry ${entryId} not found`);
  const current = await decryptEntry<EntryContent>(b64ToBytes(entries[0].encryptedData), rawEntryKey);
  const { commitHash: _drop, history: _drop2, ...withoutHash } = current;
  return saveEntrySnapshot(entryId, rawEntryKey, { ...withoutHash, deletedAt: null, updatedAt: Date.now() });
}

async function restoreVersionByCommitHash(entryId: string, commitHash: string): Promise<Entry> {
  const rawEntryKey = entryKeyCache.get(entryId);
  if (!rawEntryKey) throw new Error(`Unknown entry ${entryId}; call fetchUserEntries first`);
  const historyRows = (
    await db!.queryOnce({
      entryHistory: { $: { where: { 'entry.id': entryId } } },
    })
  ).data.entryHistory;
  for (const h of historyRows) {
    const snapshot = await decryptEntry<EntryContent>(b64ToBytes(h.encryptedSnapshot), rawEntryKey);
    if (snapshot.commitHash === commitHash) {
      const { commitHash: _drop, history: _drop2, ...withoutHash } = snapshot;
      return saveEntrySnapshot(entryId, rawEntryKey, { ...withoutHash, updatedAt: Date.now() });
    }
  }
  throw new Error(`Commit ${commitHash} not found in history for entry ${entryId}`);
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
  // entryHistory rows cascade-delete automatically: onDelete: 'cascade' is
  // set on the entryHistoryEntry link in instant.schema.ts.
  await db!.transact([db!.tx.entries[entryId].delete()]);
  entryKeyCache.delete(entryId);
}

// --- key rotation ---------------------------------------------------------------

export async function rotateRootMasterKey(newRootMasterKeyBytes: Uint8Array): Promise<void> {
  assertUnlocked();
  const newUmkBlob = await encryptUMK(umkBytes!, newRootMasterKeyBytes);
  await db!.transact([db!.tx.keyStore[keyStoreId!].update({ umkBlob: bytesToB64(newUmkBlob) })]);
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
  const authId = await requireAuthId();
  // Same $users-first, follow-the-link approach as queryOwnKeyStoreRows.
  const usersForRotation = (
    await db!.queryOnce({
      $users: { $: { where: { id: authId } }, entries: {} },
    })
  ).data.$users;
  const rows: EntriesRow[] = usersForRotation[0]?.entries || [];
  const newUmk = generateUMK();

  const rewrappedEntryKeys = await rewrapEntryKeysUnderNewUmk(rows, newUmk);
  const newUmkBlob = await encryptUMK(newUmk, rootMasterKeyBytes!);

  // Single atomic transaction: every entryKey rewrap plus the new keyStore
  // row together, so a failure anywhere leaves the old UMK and every old
  // entryKey blob fully valid (see docs/crypto.md, Key Rotation).
  await db!.transact([
    ...rewrappedEntryKeys.map(({ rowId, blob }) => db!.tx.entries[rowId].update({ entryKey: blob })),
    db!.tx.keyStore[keyStoreId!].update({ umkBlob: bytesToB64(newUmkBlob) }),
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
    history: (entry.history || []).filter((commit) => commit.hash !== entry.commitHash),
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
