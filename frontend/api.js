import { invoke } from '@tauri-apps/api/core';

function getErrorMessage(err, fallback = 'Operation failed') {
  if (!err) return fallback;
  if (typeof err === 'string') return err;
  if (typeof err === 'object') {
    if (typeof err.message === 'string' && err.message.trim()) return err.message;
    if (typeof err.type === 'string' && err.type.trim()) return err.type;
  }
  return fallback;
}

async function call(command, args = undefined) {
  try {
    return await invoke(command, args);
  } catch (err) {
    throw new Error(getErrorMessage(err));
  }
}

function normalizeSnapshot(snapshot = {}) {
  return {
    title: snapshot.title || '',
    username: snapshot.username || '',
    password: snapshot.password || '',
    cardholderName: snapshot.cardholderName || '',
    cardNumber: snapshot.cardNumber || '',
    expiry: snapshot.expiry || '',
    cvv: snapshot.cvv || '',
    notes: snapshot.notes || '',
    urls: Array.isArray(snapshot.urls) ? snapshot.urls : [],
    totpSecrets: Array.isArray(snapshot.totpSecrets) ? snapshot.totpSecrets : [],
    customFields: Array.isArray(snapshot.customFields) ? snapshot.customFields : [],
    tags: Array.isArray(snapshot.tags) ? snapshot.tags : [],
    timestamp: snapshot.timestamp || '',
  };
}

function toEntryPayload(entry) {
  return {
    title: entry.title || '',
    username: entry.username || '',
    password: entry.password || '',
    cardholderName: entry.cardholderName || '',
    cardNumber: entry.cardNumber || '',
    expiry: entry.expiry || '',
    cvv: entry.cvv || '',
    notes: entry.notes || '',
    urls: Array.isArray(entry.urls) ? entry.urls.filter((u) => u.trim()) : [],
    totpSecrets: Array.isArray(entry.totpSecrets) ? entry.totpSecrets.filter(Boolean) : [],
    customFields: Array.isArray(entry.customFields) ? entry.customFields : [],
    tags: Array.isArray(entry.tags) ? entry.tags : [],
    timestamp: entry.timestamp || new Date().toISOString(),
  };
}

function buildEntryFromDetail(meta, detail, commits = [], deletedAt = null) {
  const snapshot = normalizeSnapshot(detail?.snapshot || {});
  return {
    id: detail.id,
    type: detail.type,
    title: meta?.title ?? snapshot.title,
    username: meta?.username ?? snapshot.username,
    tags: Array.isArray(meta?.tags) ? meta.tags : snapshot.tags,
    updatedAt: meta?.updatedAt || snapshot.timestamp || '',
    deletedAt,
    ...snapshot,
    _commits: commits,
  };
}

async function getHistoryWithSnapshots(id) {
  const commits = await getHistory(id);
  const snapshots = await Promise.all(
    commits.map((commit) => getCommitSnapshot(id, commit.hash))
  );
  return commits.map((commit, index) => ({
    ...commit,
    snapshot: normalizeSnapshot(snapshots[index]),
  }));
}

async function hydrateActiveEntry(meta) {
  const detail = await getEntry(meta.id);
  const commits = await getHistoryWithSnapshots(meta.id);
  return buildEntryFromDetail(meta, detail, commits, null);
}

async function hydrateTrashEntry(meta) {
  const detail = await getTrashEntry(meta.id);
  const commits = await getHistoryWithSnapshots(meta.id).catch(() => []);
  return buildEntryFromDetail(meta, detail, commits, meta.deletedAt || null);
}

export async function initVault(username) {
  return call('init_vault', { username });
}

export async function getSetupInfo() {
  return call('get_setup_info');
}

export async function selectConfigPath(path) {
  return call('select_config_path', { path });
}

export async function browseConfigPath() {
  return call('browse_config_path');
}

export async function isVaultInitialized() {
  return call('is_initialized');
}

export async function unlockVaultSession() {
  return call('unlock_vault');
}

export async function lockVaultSession() {
  return call('lock_vault');
}

export async function listEntries(filter) {
  return call('list_entries', filter ? { filter } : {});
}

export async function getEntry(id) {
  return call('get_entry', { id });
}

export async function createEntry(entryType, snapshot) {
  return call('create_entry', {
    entryType,
    entry_type: entryType,
    snapshot,
  });
}

export async function updateEntry(id, snapshot) {
  return call('update_entry', { id, snapshot });
}

export async function deleteEntry(id) {
  return call('delete_entry', { id });
}

export async function listTrash() {
  return call('list_trash');
}

export async function getTrashEntry(id) {
  return call('get_trash_entry', { id });
}

export async function restoreEntry(id) {
  return call('restore_entry', { id });
}

export async function purgeEntry(id) {
  return call('purge_entry', { id });
}

export async function getHistory(id) {
  return call('get_history', { id });
}

export async function getCommitSnapshot(id, hash) {
  return call('get_commit_snapshot', { id, hash });
}

export async function restoreToCommit(id, hash) {
  return call('restore_to_commit', { id, hash });
}

export async function getTotp(id) {
  return call('get_totp', { id });
}

export async function exportVault() {
  return call('export_vault');
}

export async function generateRootMasterKey() {
  return call('generate_root_master_key');
}

export async function rotateMasterKey(newKeyB64) {
  return call('rotate_master_key', {
    newKeyB64,
    new_key_b64: newKeyB64,
  });
}

export async function getVaultStats() {
  return call('get_vault_stats');
}

export async function backupPush(target) {
  return call('backup_push', target ? { target } : {});
}

export async function backupPull(target) {
  return call('backup_pull', { target });
}

export async function fetchUserEntries() {
  const [entryMetas, trashMetas] = await Promise.all([listEntries(), listTrash()]);

  let failedCount = 0;

  const entries = (
    await Promise.all(
      entryMetas.map(async (meta) => {
        try {
          return await hydrateActiveEntry(meta);
        } catch {
          failedCount += 1;
          return null;
        }
      })
    )
  ).filter(Boolean);

  const trash = (
    await Promise.all(
      trashMetas.map(async (meta) => {
        try {
          return await hydrateTrashEntry(meta);
        } catch {
          failedCount += 1;
          return null;
        }
      })
    )
  ).filter(Boolean);

  return { entries, trash, failedCount };
}

export async function createUserEntry(entry) {
  const payload = toEntryPayload(entry);
  const meta = await createEntry(entry.type, payload);
  return hydrateActiveEntry(meta);
}

export async function updateUserEntry(entryId, entry) {
  const payload = toEntryPayload(entry);
  const meta = await updateEntry(entryId, payload);
  return hydrateActiveEntry(meta);
}

export async function restoreEntryVersion(entryId, commitHash) {
  const meta = await restoreToCommit(entryId, commitHash);
  return hydrateActiveEntry(meta);
}

export async function deleteUserEntry(entryId) {
  await deleteEntry(entryId);
  const meta = (await listTrash()).find((item) => item.id === entryId);
  if (!meta) {
    throw new Error('Entry moved to trash but could not be reloaded');
  }
  return hydrateTrashEntry(meta);
}

export async function restoreDeletedUserEntry(entryId) {
  const meta = await restoreEntry(entryId);
  return hydrateActiveEntry(meta);
}

export async function permanentlyDeleteUserEntry(entryId) {
  return purgeEntry(entryId);
}
