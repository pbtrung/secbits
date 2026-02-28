# Tauri IPC Commands — SecBits

All commands are invoked from the frontend with `invoke(commandName, args)`.
Commands are registered in `src-tauri/src/commands.rs` and wired into the Tauri
builder in `src-tauri/src/main.rs`.

Errors are returned as structured JSON objects from `AppError` variants.

---

## Session

### `unlock_vault()`

Unlock the vault using the config file. Reads `root_master_key_b64`, `db_path`,
and `username` from the config TOML. Decrypts the user master key and stores it
in `AppState`.

```ts
invoke("unlock_vault"): Promise<void>
```

Errors: `ConfigNotFound`, `DatabaseNotFound`, `WrongRootMasterKey`, `UserNotFound`.

---

### `lock_vault()`

Zero session keys in `AppState`. React state should be cleared by the caller.

```ts
invoke("lock_vault"): Promise<void>
```

---

### `is_initialized()`

Return whether the database has been initialized for the configured username.

```ts
invoke("is_initialized"): Promise<boolean>
```

---

### `init_vault(username: string)`

Create the database schema, generate a user master key, and store it encrypted
under the root master key. Called on first run.

```ts
invoke("init_vault", { username: string }): Promise<void>
```

Errors: `DatabaseAlreadyInitialized`, `ConfigNotFound`.

---

## Entries (Active)

### `list_entries(filter?: string)`

Return all active (non-deleted) entries matching an optional path prefix or tag
filter. Returns metadata only — no decrypted field values.

```ts
invoke("list_entries", { filter?: string }): Promise<EntryMeta[]>

interface EntryMeta {
  id: string           // path_hint
  type: EntryType      // "login" | "note" | "card"
  title: string
  username?: string    // login only
  tags: string[]
  updatedAt: string    // ISO 8601, timestamp of HEAD commit
}
```

---

### `get_entry(id: string)`

Decrypt and return the full current snapshot for one entry.

```ts
invoke("get_entry", { id: string }): Promise<EntryDetail>

interface EntryDetail {
  id: string
  type: EntryType
  snapshot: EntrySnapshot
}
```

Errors: `EntryNotFound`, `DecryptionFailedAuthentication`.

---

### `create_entry(path: string, type: EntryType, snapshot: EntrySnapshot)`

Insert a new entry. `path` is the path_hint (e.g. `"mail/google/main"`).

```ts
invoke("create_entry", {
  path: string,
  type: EntryType,
  snapshot: EntrySnapshot,
}): Promise<EntryMeta>
```

Errors: `EntryAlreadyExists`, `InvalidPathHint`.

---

### `update_entry(id: string, snapshot: EntrySnapshot)`

Update an existing entry. If the new snapshot content hash equals the current
HEAD, returns the current entry unchanged (dedup).

```ts
invoke("update_entry", {
  id: string,
  snapshot: EntrySnapshot,
}): Promise<EntryMeta>
```

Errors: `EntryNotFound`.

---

### `delete_entry(id: string)`

Soft-delete an entry (move to trash). Sets `deleted_at` to now.

```ts
invoke("delete_entry", { id: string }): Promise<void>
```

Errors: `EntryNotFound`.

---

## Trash

### `list_trash()`

Return all trashed entries (metadata only).

```ts
invoke("list_trash"): Promise<TrashedEntryMeta[]>

interface TrashedEntryMeta extends EntryMeta {
  deletedAt: string   // ISO 8601
}
```

---

### `get_trash_entry(id: string)`

Decrypt and return the full snapshot of a trashed entry.

```ts
invoke("get_trash_entry", { id: string }): Promise<EntryDetail>
```

---

### `restore_entry(id: string)`

Move a trashed entry back to active. Clears `deleted_at`.

```ts
invoke("restore_entry", { id: string }): Promise<EntryMeta>
```

Errors: `EntryNotFound`.

---

### `purge_entry(id: string)`

Permanently delete a trashed entry. No recovery path.

```ts
invoke("purge_entry", { id: string }): Promise<void>
```

Errors: `EntryNotFound`.

---

## History

### `get_history(id: string)`

Return the commit list for an entry (without decrypting delta values).

```ts
invoke("get_history", { id: string }): Promise<CommitMeta[]>

interface CommitMeta {
  hash: string
  parent: string | null
  timestamp: string
  changed: string[]
}
```

---

### `get_commit_snapshot(id: string, hash: string)`

Reconstruct and return the full snapshot at a specific commit (for diff display).

```ts
invoke("get_commit_snapshot", {
  id: string,
  hash: string,
}): Promise<EntrySnapshot>
```

Errors: `EntryNotFound`, `CommitNotFound`.

---

### `restore_to_commit(id: string, hash: string)`

Restore an entry to a prior commit. Creates a new HEAD commit with the
reconstructed snapshot. Returns the updated entry meta.

```ts
invoke("restore_to_commit", {
  id: string,
  hash: string,
}): Promise<EntryMeta>
```

Errors: `EntryNotFound`, `CommitNotFound`.

---

## TOTP

### `get_totp(id: string)`

Compute the current RFC 6238 TOTP code for an entry. Returns all codes if the
entry has multiple TOTP secrets.

```ts
invoke("get_totp", { id: string }): Promise<TotpResult[]>

interface TotpResult {
  code: string         // 6-digit string, zero-padded
  remainingSecs: number
}
```

Errors: `EntryNotFound`, `NoTotpSecret`.

---

## Export

### `export_vault()`

Decrypt all entries (active + trash) and return a JSON string in the canonical
export format. Shows a warning in the UI before calling.

```ts
invoke("export_vault"): Promise<string>  // JSON string
```

---

## Settings

### `rotate_master_key(newKeyB64: string)`

Re-encrypt the user master key under a new root master key. The new key must be
a base64-encoded string of ≥256 raw bytes.

```ts
invoke("rotate_master_key", { newKeyB64: string }): Promise<void>
```

Errors: `InvalidRootMasterKey`.

---

### `get_vault_stats()`

Return summary statistics for the vault.

```ts
invoke("get_vault_stats"): Promise<VaultStats>

interface VaultStats {
  entryCount: number
  trashCount: number
  loginCount: number
  noteCount: number
  cardCount: number
  topTags: { tag: string; count: number }[]
  totalCommits: number
  avgCommitsPerEntry: number
}
```

---

## Backups

### `backup_push(target?: string)`

Push an encrypted backup to an S3 target. If `target` is omitted and
`backup_on_save = true`, all configured targets are used; otherwise the named
target is required.

```ts
invoke("backup_push", { target?: string }): Promise<void>
```

Errors: `BackupTargetNotConfigured`, `BackupUploadFailed`.

---

### `backup_pull(target: string)`

Download the latest encrypted backup from an S3 target and atomically replace
the local database. Requires confirmation from the UI before calling.

```ts
invoke("backup_pull", { target: string }): Promise<void>
```

Errors: `BackupTargetNotConfigured`, `BackupDownloadFailed`, `DecryptionFailedAuthentication`.

---

## Shared Types

```ts
type EntryType = "login" | "note" | "card"

interface EntrySnapshot {
  title: string
  username?: string
  password?: string
  cardholderName?: string
  cardNumber?: string
  expiry?: string
  cvv?: string
  notes?: string
  urls?: string[]
  totpSecrets?: string[]
  customFields?: { id: number; label: string; value: string }[]
  tags?: string[]
  timestamp: string   // ISO 8601; set by backend on create/update
}
```

---

## Error Types

`AppError` variants serialized to `{ "type": "VariantName", "message"?: "..." }`:

| Variant | When |
|---------|------|
| `ConfigNotFound` | Config file missing or unreadable |
| `DatabaseNotFound` | SQLite file missing |
| `DatabaseAlreadyInitialized` | `init_vault` called on existing DB |
| `UserNotFound` | Username in config not in DB |
| `WrongRootMasterKey` | Root key decryption failure |
| `DecryptionFailedAuthentication` | AEAD tag mismatch |
| `EntryNotFound` | ID does not exist in DB |
| `EntryAlreadyExists` | `path_hint` collision on insert |
| `InvalidPathHint` | Path contains invalid characters |
| `CommitNotFound` | Hash not in entry history |
| `NoTotpSecret` | Entry has no TOTP secrets |
| `InvalidRootMasterKey` | New key is too short or not valid base64 |
| `BackupTargetNotConfigured` | Named target absent from config |
| `BackupUploadFailed` | S3 upload error |
| `BackupDownloadFailed` | S3 download error |
| `ShareKeysNotInitialized` | Sharing keypair not generated yet |
| `Internal` | Unexpected error; includes message |
