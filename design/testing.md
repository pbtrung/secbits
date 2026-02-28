# Testing

## Overview

Tests are split into three layers:

| Layer | Toolchain | Location |
|-------|-----------|----------|
| Rust unit + integration | `cargo test` | `backend/src/` and `backend/tests/` |
| Frontend unit | Vitest | `frontend/` |
| End-to-end | Rust integration tests with mock IPC | `backend/tests/` |

Run all tests:

```bash
cd backend && cargo test
npm test
```

---

## Rust Backend Tests

### crypto.rs

**Round-trip correctness**

- Encrypt then decrypt with same key returns original plaintext.
- Empty plaintext (zero bytes) encrypts and decrypts correctly.
- Large plaintext (1 MB) encrypts and decrypts correctly.
- Encrypting the same plaintext twice with the same key produces two different ciphertexts (fresh salt each time, no IV reuse).

**Blob layout**

- Output of `encrypt_bytes_to_blob` has the structure `magic(2) || version(2) || salt(64) || ciphertext(var) || tag(64)`.
- Blob length equals `4 + 64 + plaintext_len + 64` for any plaintext length.
- Minimum valid blob (zero-byte plaintext) is exactly 132 bytes.
- magic bytes at positions 0..2 equal `0x53 0x42`.
- version bytes at positions 2..4 equal `0x01 0x00` for v1.0.

**Wrong key rejection**

- Decrypting with a different key of the same length returns `DecryptionFailedAuthentication`.
- Decrypting with an all-zero key when encrypted with a random key returns `DecryptionFailedAuthentication`.

**Blob tampering detection**

- Flip one bit in the magic field → `InvalidBlobFormat` (magic mismatch).
- Change the major version byte to an unrecognized value → version rejection before any decryption.
- Flip one bit in the salt field → `DecryptionFailedAuthentication` (AAD mismatch, tag invalid).
- Flip one bit anywhere in the ciphertext body → `DecryptionFailedAuthentication`.
- Flip one bit in the tag field → `DecryptionFailedAuthentication`.
- Truncate blob to 131 bytes → `InvalidBlobFormat` (below minimum length).
- Truncate blob to 0 bytes → `InvalidBlobFormat`.
- Append extra bytes after the tag → `InvalidBlobFormat` or `DecryptionFailedAuthentication` (no silent acceptance of garbage).

**AAD coverage**

- AAD is `magic || version || salt` = 68 bytes.
- Modifying any of these three fields causes tag verification failure even with correct key.

**HKDF determinism**

- `hkdf_sha3_512(key, salt)` with identical inputs returns identical output on repeated calls.
- Changing key by one bit produces a different output.
- Changing salt by one bit produces a different output.
- Output length is exactly 128 bytes; first 64 = encKey, last 64 = encIv.

**Key length validation**

- Root master key shorter than 256 decoded bytes is rejected with `InvalidRootMasterKey`.
- Root master key of exactly 256 bytes is accepted.
- Root master key of 512 bytes is accepted.
- Non-base64 string for root master key returns a parse error.

---

### model.rs

**Content hash**

- `content_hash` is deterministic: same snapshot fields produce the same hash.
- `content_hash` excludes the `timestamp` field: two snapshots identical except for timestamp have the same hash.
- `content_hash` is sensitive to field changes: changing any data field changes the hash.
- Hash output is exactly 32 hex characters (lowercase).

**normalize_for_compare**

- Tags comparison is case-insensitive: `["Work"]` equals `["work"]`.
- Tags comparison is order-independent: `["a", "b"]` equals `["b", "a"]`.
- URL comparison strips trailing slash: `"https://example.com/"` equals `"https://example.com"`.
- URL comparison is case-insensitive on scheme and host: `"HTTPS://Example.COM"` equals `"https://example.com"`.
- `customFields` comparison matches by `id`, not array index: reordering custom fields with the same ids is not a change.
- `customFields` with different `id` values are treated as different fields.
- `totpSecrets` comparison is order-independent (set comparison).
- All other string fields use direct equality: leading/trailing space is a real change.

**append_snapshot: single commit**

- First `append_snapshot` creates `commits[0]` with `parent = null`, `delta = null`.
- `head` equals the hash of the first snapshot.
- `head_snapshot` equals the first snapshot (with timestamp set by caller).
- `commits` has exactly one entry.

**append_snapshot: second commit**

- Second `append_snapshot` with different content prepends a new commit as `commits[0]`.
- Previous `commits[0]` moves to `commits[1]` and gains a `delta` with its fields.
- `parent` of `commits[0]` equals hash of `commits[1]`.
- `commits[1].delta.set` contains all non-empty fields of that commit's snapshot.
- `commits[1].delta.unset` lists fields that were absent or empty at that commit.
- `changed` on `commits[0]` lists only the fields that differ from `commits[1]`.

**dedup**

- Saving a snapshot with the same content hash as the current HEAD does not append a commit.
- The history object is returned unchanged (same `head`, same `commits` length).
- A snapshot differing only in timestamp does not create a new commit (hash excludes timestamp).

**history overflow: 20-commit cap**

- Appending a 21st snapshot drops the oldest commit (index 19 before drop).
- After drop, `commits` has exactly 20 entries.
- The new oldest commit (previously second-oldest) gets its `delta` rebuilt as a full-snapshot delta with all its fields in `delta.set` and `parent = null`.
- Repeated overflow (adding the 22nd, 23rd, etc.) continues to maintain exactly 20 commits.

**delta reconstruction**

- `reconstruct_snapshot(history, hash)` for `hash == history.head` returns `head_snapshot`.
- `reconstruct_snapshot` for the second-most-recent commit applies one delta backward and returns a snapshot matching what was saved at that commit.
- `reconstruct_snapshot` for the oldest commit returns a full snapshot matching the original creation snapshot.
- `reconstruct_snapshot` for a non-existent hash returns `CommitNotFound`.
- Fields in `delta.unset` appear as absent or empty in the reconstructed snapshot.
- Fields in `delta.set` appear with their original values in the reconstructed snapshot.

**restore_to_commit**

- Restoring to HEAD hash returns the history unchanged (no new commit).
- Restoring to an older hash creates a new HEAD commit with the reconstructed snapshot.
- Dedup applies: if reconstructed snapshot content equals current head, no commit is appended.
- Restoring the oldest commit and then restoring back to HEAD returns the original HEAD content.

**changed[] accuracy**

- Adding a URL is detected as a change to the `urls` field.
- Removing a custom field is detected.
- Changing a tag case only (e.g., "Work" to "work") is NOT detected as a change (normalize_for_compare).
- Changing password is detected.
- No change in any field: no commit appended.

---

### compression.rs

- Compress then decompress returns original bytes.
- Empty input compresses and decompresses to empty bytes.
- Large repetitive JSON (100 KB) compresses to less than 50% of original size.
- Brotli-compressed output decompresses to bytes equal to original (not just length-equal).
- Decompressing corrupted bytes returns an error (does not panic).

---

### db.rs

**Schema creation**

- `create_schema` creates all four tables: `vault_info`, `key_store`, `entries`, `trash`.
- Running `create_schema` on an already-initialized database is idempotent (uses `CREATE TABLE IF NOT EXISTS` or equivalent).
- All expected columns exist with correct types.

**vault_info**

- Insert and retrieve all three standard keys: `username`, `created_at`, `schema_version`.
- Inserting a duplicate key updates the value (upsert), not duplicates.
- Missing key returns None, not an error.

**key_store**

- Insert UMK row and retrieve it with `WHERE type = 'umk'` returns exactly one row.
- Two UMK rows cannot coexist: inserting a second UMK must either be prevented or replace the first.
- `identity_sk`, `identity_pk`, `contact_pk`, `emergency` rows insert and retrieve correctly.
- `label` is nullable and stored as NULL when not provided.
- `rotated_at` is NULL until explicitly updated.

**entries CRUD**

- Insert entry returns new `entry_id`.
- Select by `entry_id` returns the row.
- Update `entry_key` and `value` in place.
- Active entries query (`NOT IN trash`) excludes entries with a trash row.
- No columns other than `entry_id`, `entry_key`, `value` exist on the entries table.

**trash**

- Insert a trash row; the entry no longer appears in the active list.
- Trash list query returns the entry with its `deleted_at` timestamp.
- Delete the trash row; the entry reappears in the active list (restore).
- Delete trash row then entries row (purge): entry_id is gone from both tables.
- Inserting a duplicate `entry_id` into trash violates the primary key constraint.
- Deleting an `entries` row that still has a `trash` row violates the foreign key constraint.

**referential integrity**

- FK from `trash.entry_id` to `entries.entry_id` is enforced (requires `PRAGMA foreign_keys = ON`).

---

### config.rs

- Valid minimal config (root_master_key, db_path) loads without error.
- Full config with backup targets loads without error.
- Missing `root_master_key` returns `ConfigNotFound` or a parse error.
- `root_master_key` that decodes to fewer than 256 bytes returns `InvalidRootMasterKey`.
- `root_master_key` that is invalid base64 returns a parse error.
- Missing `db_path` returns an error.
- `backup_on_save = true` is parsed correctly; absence defaults to false.
- Backup targets list: empty list is valid; multiple targets are all loaded.
- Unknown config keys are tolerated (forward compatibility).
- `username` field is optional in config (vault_info holds the canonical username).

---

### app.rs (command-level tests)

**init_vault**

- `init_vault("alice")` creates schema, writes vault_info rows, generates and stores encrypted UMK.
- After `init_vault`, `is_initialized()` returns true.
- Calling `init_vault` on an already-initialized DB returns `DatabaseAlreadyInitialized`.

**unlock_vault / lock_vault**

- `unlock_vault` with correct root key populates `AppState` with decrypted UMK.
- `unlock_vault` with wrong root key returns `WrongRootMasterKey` and leaves `AppState` locked.
- `lock_vault` zeroes session keys; subsequent `get_entry` calls fail with a session error.
- `unlock_vault` after `lock_vault` restores session.
- `unlock_vault` when DB file does not exist returns `DatabaseNotFound`.
- `unlock_vault` when config is missing returns `ConfigNotFound`.

**entry lifecycle**

- `create_entry` inserts a new entry and returns correct `EntryMeta`.
- `get_entry` on the created entry decrypts and returns correct snapshot.
- `update_entry` with changed fields creates a new commit and returns updated `EntryMeta`.
- `update_entry` with identical content returns current entry unchanged.
- `delete_entry` moves the entry to trash; it no longer appears in `list_entries`.
- `list_entries` without filter returns all active entries.
- `list_entries` with tag filter returns only entries with that tag.
- `list_entries` with search string matches title, username, and URL fields.
- `get_entry` on a non-existent id returns `EntryNotFound`.
- `update_entry` on a non-existent id returns `EntryNotFound`.

**trash lifecycle**

- `list_trash` returns entries with `deletedAt` timestamps.
- `get_trash_entry` decrypts and returns the trashed entry's snapshot.
- `restore_entry` removes the trash row; entry reappears in `list_entries`.
- `purge_entry` permanently removes the entry; subsequent `get_entry` returns `EntryNotFound`.
- `purge_entry` on a non-existent id returns `EntryNotFound`.
- `restore_entry` on a non-existent id returns `EntryNotFound`.

**history commands**

- `get_history` returns commits in order newest-first.
- `get_history` does not include delta field values.
- `get_commit_snapshot` reconstructs the correct snapshot for each hash in history.
- `get_commit_snapshot` with unknown hash returns `CommitNotFound`.
- `restore_to_commit` creates a new HEAD; `get_history` shows one more commit (unless dedup).
- `restore_to_commit` to HEAD is a no-op; history length unchanged.

**TOTP**

- `get_totp` returns correct 6-digit code for RFC 6238 test vector `GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ` at T=59.
- `get_totp` returns all codes when entry has multiple TOTP secrets.
- `get_totp` returns `remainingSecs` in the range 1 to 30.
- `get_totp` on entry with no TOTP secrets returns `NoTotpSecret`.
- `get_totp` on non-existent entry returns `EntryNotFound`.

**export**

- `export_vault` returns valid JSON string.
- Parsed export includes all active entries.
- Parsed export includes all trashed entries under `"trash"`.
- Each active entry in export includes `type`, `title`, and all non-empty fields.
- `_commits` array contains linearized commit list without delta values.
- `id` field in export equals `entry_id`.

**settings**

- `rotate_master_key` with a valid new key re-encrypts the UMK blob.
- After rotation, `unlock_vault` with the old key returns `WrongRootMasterKey`.
- After rotation, `unlock_vault` with the new key succeeds and all entries are intact.
- `rotate_master_key` with a key decoding to fewer than 256 bytes returns `InvalidRootMasterKey`.
- `get_vault_stats` entry counts match actual rows in DB.
- `get_vault_stats` type breakdown (loginCount, noteCount, cardCount) sums to entryCount.
- `get_vault_stats` totalCommits equals sum of commit counts across all active entries.

---

### backup.rs

- `backup_push` encrypts the local SQLite file as a blob and uploads to the configured S3 target.
- `backup_push` with unknown target name returns `BackupTargetNotConfigured`.
- `backup_push` on S3 upload failure returns `BackupUploadFailed`.
- `backup_pull` downloads the latest backup object, decrypts it, and atomically replaces the local DB.
- `backup_pull` with a blob encrypted under a different key returns `DecryptionFailedAuthentication`.
- `backup_pull` with unknown target returns `BackupTargetNotConfigured`.
- `backup_pull` on S3 download failure returns `BackupDownloadFailed`.
- When `backup_on_save = true`, a push is triggered after each write command.
- Backup object key includes an ISO 8601 timestamp for lexicographic ordering.

---

## Frontend Tests (Vitest)

### totp.js

- RFC 6238 test vector: secret `GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ`, T=59 → `287082`.
- RFC 6238 test vector: T=1111111109 → `081804`.
- RFC 6238 test vector: T=1111111111 → `050471`.
- Output is always a 6-character string, zero-padded.
- Step boundary: code changes at multiples of 30 seconds.

### validation.js

- Title is required: empty title fails validation.
- Title longer than the max length fails validation.
- URL field: valid URL passes; bare word without scheme fails.
- TOTP secret: valid base32 string passes; non-base32 characters fail.
- Expiry: valid `MM/YY` format passes; `13/25` (invalid month) fails; `01/2025` fails.
- Card number: digits and spaces accepted; letters rejected.
- Custom field label: empty label fails.

### entryUtils.js

- `getFields("login")` returns the correct list of field descriptors.
- `getFields("note")` returns title and notes only.
- `getFields("card")` returns card-specific fields.
- Unknown type returns an empty list or throws (not silently wrong).

### PasswordGenerator

- Generated password length matches the requested length.
- Uppercase-only mode: output contains only uppercase letters.
- Lowercase-only mode: output contains only lowercase letters.
- Digits-only mode: output contains only digits.
- Symbols mode: output characters are within the defined symbol set.
- Symbol set does not include `"` or `\`.
- All character classes enabled: output contains at least one character from each class.
- No character classes enabled: generation is rejected or produces an error.
- Multiple generates: outputs are not identical (random source).

### api.js

- Each wrapper calls `invoke` with the correct command name and argument shape.
- On success, the wrapper returns the value from `invoke`.
- On error, the wrapper re-throws the structured `AppError` object.
- `list_entries` passes `filter` as an optional argument.
- `create_entry` passes `type` and `snapshot` as separate arguments.

### Components

**AppSetup**

- Renders vault unlock form when `is_initialized` is true.
- Renders first-run setup form when `is_initialized` is false.
- Submit with empty username shows validation error (first-run).
- Submit triggers the correct IPC call.
- Loading state shown while IPC call is in flight.
- Error message shown when `WrongRootMasterKey` is returned.

**TagsSidebar**

- Renders "All Items" and "Trash" links.
- Renders one tag entry per unique tag with correct count.
- Clicking a tag calls the filter callback.
- Active tag is visually highlighted.

**EntryList**

- Renders one row per entry in the provided list.
- Clicking a row calls the selection callback with the entry id.
- Search input filters the list by title.
- Empty list renders a placeholder, not an error.
- Trashed entries show `deletedAt` date.

**EntryDetail**

- Renders the correct field set for `login` type.
- Renders the correct field set for `note` type.
- Renders the correct field set for `card` type.
- Edit mode shows form inputs; view mode shows static values.
- Save button is disabled while save is in flight (SpinnerBtn).
- Dirty state indicator shown when unsaved changes exist.

**CopyBtn**

- Click writes the target value to the clipboard (mock `navigator.clipboard`).
- Shows a temporary confirmation state after copy.
- Confirmation state resets after the timeout.

**EyeToggleBtn**

- Clicking toggles the field type between `password` and `text`.
- Initial state is hidden (`type="password"`).

**HistoryDiffModal**

- Renders the commit list in newest-first order.
- Selecting a commit shows the diff for that commit.
- Changed fields are highlighted; unchanged fields are not.
- "Restore to this version" button triggers `restore_to_commit`.
- HEAD commit does not show a restore button (already current).

**ResizeHandle**

- Drag event updates the column width via the provided callback.
- Mouse-up stops drag state.

---

## Integration Tests

These tests run against a real (in-memory or temp-file) SQLite database and a real
leancrypto instance, using Tauri command handlers directly.

**Full vault lifecycle**

1. `init_vault("alice")` on a fresh DB.
2. `is_initialized()` returns true.
3. `unlock_vault()` with correct config succeeds.
4. `create_entry` for each type (login, note, card); all return correct meta.
5. `list_entries` returns all three.
6. `get_entry` on each; snapshot fields match what was saved.
7. `update_entry` on the login entry; second call with same data is a no-op.
8. `get_history` on the login entry shows two commits.
9. `get_commit_snapshot` for both commits returns correct snapshots.
10. `restore_to_commit` to the first commit; history now has three commits.
11. `delete_entry` on the note entry; `list_entries` returns two entries.
12. `list_trash` shows the deleted note.
13. `restore_entry`; note reappears in `list_entries`.
14. `delete_entry` again; `purge_entry`; note is permanently gone.
15. `lock_vault`; `get_entry` returns session error.
16. `unlock_vault` again; entries intact.

**Root key rotation**

1. `init_vault`, `unlock_vault` with key A.
2. Create two entries.
3. `rotate_master_key` with key B.
4. `lock_vault`.
5. `unlock_vault` with key A → `WrongRootMasterKey`.
6. `unlock_vault` with key B → success.
7. `get_entry` on both entries → correct snapshots.

**History overflow**

1. Create one entry.
2. `update_entry` 20 times with distinct content.
3. History has 20 commits.
4. `update_entry` a 21st time; history still has 20 commits.
5. Oldest commit has a full-snapshot delta.
6. `reconstruct_snapshot` for every hash in history returns a valid snapshot.

**Corrupt blob handling**

1. Create an entry.
2. Directly corrupt the `value` blob in SQLite (flip a byte in the ciphertext).
3. `get_entry` returns `DecryptionFailedAuthentication`; app does not crash.
4. Other entries are unaffected.

**Cross-type entry isolation**

- Decrypt login entry using card entry's doc key → `DecryptionFailedAuthentication`.
- Entries cannot decrypt each other's blobs.

**Export completeness**

1. Create 5 active entries and delete 2.
2. `export_vault` returns JSON with 5 entries in `data` and 2 in `trash`.
3. Parse the JSON; all fields present; `_commits` arrays non-empty.

**Missing database file**

- Config points to a non-existent DB path.
- `unlock_vault` returns `DatabaseNotFound`.

**Missing config file**

- Config file does not exist.
- `unlock_vault` returns `ConfigNotFound`.

**Backup round-trip (with mock S3)**

1. Init vault, create entries.
2. `backup_push` to mock S3.
3. Delete the local DB file.
4. `backup_pull` from mock S3.
5. `unlock_vault`; all entries intact.

**TOTP multi-secret**

1. Create a login entry with two TOTP secrets.
2. `get_totp` returns two results.
3. Each result has a 6-digit code and `remainingSecs` in range 1..=30.

**Concurrent session safety**

- Two Tauri windows sharing the same `AppState` via `Mutex`: write from one does not corrupt
  the view from the other. (Rust `Mutex<DbConn>` serializes access.)
