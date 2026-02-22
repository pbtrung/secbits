# SecBits

This document is the full implementation design for rebuilding SecBits as an offline-first Rust application from an empty repository state.

It is intentionally detailed and prescriptive so implementation can start immediately without referencing the prior JavaScript codebase.

## 1. Objectives

1. Build a local/offline password manager in Rust.
2. Preserve the existing encryption, decryption, and authentication/key-lifecycle model.
3. Use system-installed libraries: leancrypto (HKDF-SHA3-512 + Ascon-Keccak-512 AEAD), brotli (pre-encryption compression), and sqlite (local storage).
4. Mimic pass-style UX with path-oriented entries.
5. Keep commit-history semantics compatible with current logic (hashing, dedup, restore, compact history object).
6. Support encrypted cloud backups through S3-compatible object storage.

## 2. Non-Goals

1. No Firebase integration.
2. No browser UI.
3. No automatic multi-device cloud sync.
4. No format migration tooling unless explicitly added later.

## 3. Runtime and Toolchain

1. Rust stable (target edition: 2021 or newer).
2. Linux-first implementation.
3. Dynamic linking to system libraries: `libsqlite3`, `libbrotlienc + libbrotlidec`, and `libleancrypto` (or project-local build artifact if system package is unavailable).

## 4. High-Level Architecture

Single binary CLI:

- `secbits` command with subcommands.
- Local database file (default: `~/.local/share/secbits/secbits.db`).
- TOML config file (default: `~/.config/secbits/config.toml`).
- Session state contains decrypted User Master Key only in process memory for the duration of each command invocation.

Internal modules:

1. `cli`: argument parsing, interactive prompts, command routing.
2. `db`: sqlite connection lifecycle, schema migrations, CRUD for users/entries.
3. `crypto`: thin safe wrappers around leancrypto FFI, byte layout encode/decode, zeroization helpers.
4. `compression`: brotli encode/decode wrappers.
5. `model`: entry payload structs, history structs, delta reconstruction.
6. `app`: domain flows (login/init/insert/show/edit/history/restore).
7. `backup`: backup pack/unpack, S3-compatible upload/download flows.

### 4.1 CLI TOML Config

Config file format: TOML.

```toml
root_master_key_b64 = "BASE64_ROOT_MASTER_KEY"
db_path = "/home/user/.local/share/secbits/secbits.db"

[targets.r2]
provider = "r2"
endpoint = "https://<account>.r2.cloudflarestorage.com"
region = "auto"
bucket = "secbits-backups-r2"
prefix = "prod/"
access_key_id = "..."
secret_access_key = "..."
session_token = "" # optional

[targets.aws]
provider = "aws"
region = "us-east-1"
bucket = "secbits-backups-aws"
prefix = "prod/"
access_key_id = "..."
secret_access_key = "..."
session_token = "" # optional

[targets.gcs]
provider = "gcs"
endpoint = "https://storage.googleapis.com"
region = "auto"
bucket = "secbits-backups-gcs"
prefix = "prod/"
access_key_id = "..."
secret_access_key = "..."
session_token = "" # optional
```

Rules:

1. `root_master_key_b64` must decode and satisfy root key length validation.
2. `db_path` points to the local SQLite database file used by the CLI.
3. `[targets.<name>]` defines one or more S3-compatible backup targets, allowing R2, AWS S3, and GCS to be configured at the same time.
4. `provider` identifies behavior differences (`r2`, `aws`, `gcs`) while still using S3 API-compatible upload/download flows.
5. Secrets in config must be protected by filesystem permissions (`0600`) or environment override strategy.

## 5. SQLite Schema

Schema version tracking uses SQLite's built-in `PRAGMA user_version`. The migration runner reads this value on startup, applies any pending migrations in order, and updates it to the new version.

```sql
PRAGMA user_version = 1;

CREATE TABLE users (
  user_id INTEGER PRIMARY KEY,
  user_master_key BLOB NOT NULL,
  username TEXT NOT NULL UNIQUE
);

CREATE TABLE entries (
  entry_id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  path_hint TEXT NOT NULL UNIQUE,
  entry_key BLOB NOT NULL,
  value BLOB NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE INDEX idx_entries_user_id ON entries(user_id);
```

Notes:

1. `user_id` and `entry_id` are integer primary keys.
2. `path_hint` stores pass-style path (`mail/google/main`) and is globally unique.
3. `entry_key` stores wrapped per-entry doc key bytes.
4. `value` stores encrypted history blob bytes.
5. Secrets must never be written to plaintext columns.
6. Each schema change increments `PRAGMA user_version` and is implemented as a numbered migration in the migration runner.

## 6. Cryptographic Invariants (Must Match Existing Design)

Constants:

- `SALT_LEN = 64`
- `USER_MASTER_KEY_LEN = 64`
- `DOC_KEY_LEN = 64`
- `ENC_KEY_LEN = 64`
- `ENC_IV_LEN = 64` (512-bit IV as required by the leancrypto Ascon-Keccak-512 API; verify against leancrypto header definitions before finalizing)
- `TAG_LEN = 64`
- `HKDF_OUT_LEN = 128` (= `ENC_KEY_LEN + ENC_IV_LEN`)
- `MASTER_BLOB_LEN = 192` (= `SALT_LEN + USER_MASTER_KEY_LEN + TAG_LEN`)

Algorithms:

1. HKDF with SHA3-512 via leancrypto.
2. AEAD Ascon-Keccak-512 via leancrypto. Ciphertext length equals plaintext length (stream cipher mode); authentication is provided by the separate 64-byte tag.
3. Brotli compression before encrypting entry history.
4. Blob layout: `salt || ciphertext || tag`.

### 6.1 Root Master Key Validation

Input root key is base64 text.

Validation rules:

1. Must decode successfully.
2. Decoded length must be `>= 256` bytes.
3. Else fail fast with explicit error.

Key generation guidance: generate at least 256 bytes of cryptographically random data and base64-encode it. Example: `openssl rand -base64 344 | tr -d '\n'` produces a 256-byte decoded key.

### 6.2 User Master Key Setup (First Login)

1. Generate random `user_master_key` (64 bytes).
2. Generate random `salt` (64 bytes).
3. Derive `{encKey, encIv}` from `root_master_key + salt` using HKDF-SHA3-512.
4. AEAD-encrypt `user_master_key` using `{encKey, encIv}` with 64-byte tag.
5. Persist `user_master_key_blob = salt || encrypted_user_master_key || tag` (192 bytes).
6. Keep plaintext user master key in memory only for the current process invocation.

### 6.3 User Master Key Verify (Returning Login)

1. Load stored blob from `users.user_master_key`.
2. Validate blob size = 192 bytes.
3. Parse:
   - `salt = blob[0..64]`
   - `enc_user_master_key = blob[64..128]`
   - `tag = blob[128..192]`
4. Re-derive `{encKey, encIv}` from root key + salt.
5. AEAD-decrypt and authenticate.
6. On auth failure: return `WrongRootMasterKey`.

### 6.4 `encryptBytesToBlob` / `decryptBytesFromBlob` Helpers

These are the two primitive helpers used throughout §7 and §15 for all encryption operations. Both functions generate or consume a fresh salt per call.

`encryptBytesToBlob(key, plaintext) -> blob`:

1. Generate fresh random `salt` (64 bytes).
2. Derive `{encKey, encIv}` from `key + salt` using HKDF-SHA3-512.
3. AEAD-encrypt `plaintext` with `{encKey, encIv}`, producing `ciphertext` (same length as plaintext) and `tag` (64 bytes).
4. Return `salt || ciphertext || tag`.

`decryptBytesFromBlob(key, blob) -> plaintext`:

1. Parse `salt = blob[0..64]`, `ciphertext = blob[64..len-64]`, `tag = blob[len-64..len]`.
2. Re-derive `{encKey, encIv}` from `key + salt`.
3. AEAD-decrypt and authenticate. Return plaintext or `DecryptionFailedAuthentication`.

Note: `encKey` and `encIv` are re-derived per call from a fresh salt, ensuring no key or IV reuse across separate encryption operations.

## 7. Data-at-Rest Columns in `entries`

`entries` stores wrapped key and encrypted payload in separate columns:

1. `entry_key = encryptBytesToBlob(user_master_key, doc_key)`
2. `value = encryptBytesToBlob(doc_key, brotli(JSON(history_object)))`

Each call to `encryptBytesToBlob` generates a fresh random salt, ensuring unique ciphertext even for identical plaintexts.

Rationale:

- Mirrors the existing app model (`entry_key` + `value`).
- Keeps wrapped per-entry doc key semantics unchanged.
- Keeps history encryption and compression semantics unchanged.

## 8. Entry Model and Commit History

Entry plaintext object fields (current compatibility baseline):

1. `title: string`
2. `username: string`
3. `password: string`
4. `notes: string`
5. `urls: string[]`
6. `totpSecrets: string[]`
7. `customFields: [{ id: number, label: string, value: string }]`
8. `tags: string[]`
9. `timestamp: ISO-8601 string`

Tracked fields for change detection:

- `title`, `username`, `password`, `notes`, `urls`, `totpSecrets`, `customFields`, `tags`

### 8.1 Commit Hash

1. Build content object excluding `timestamp`.
2. Stable top-level key ordering.
3. SHA-256 digest. SHA-256 is used intentionally for commit identity (non-security-critical); it is distinct from the SHA3-512 used in the encryption stack.
4. Use first 12 hex characters as commit hash.

### 8.2 Commit Object

```json
{
  "hash": "a1b2c3d4e5f6",
  "parent": "f7e8d9c0b1a2",
  "timestamp": "2026-02-22T00:00:00Z",
  "changed": ["password"]
}
```

### 8.3 Compact Storage Object

Store encrypted JSON as:

```json
{
  "head": "a1b2c3d4e5f6",
  "head_snapshot": { "...": "..." },
  "commits": [
    { "hash": "a1b2c3d4e5f6", "parent": "f7e8d9c0b1a2", "timestamp": "...", "changed": ["password"] },
    { "hash": "f7e8d9c0b1a2", "parent": null, "timestamp": "...", "changed": ["password"], "delta": { "set": { "password": "old" }, "unset": [] } }
  ]
}
```

Rules:

1. `commits[0]` is the HEAD commit. It never carries a `delta` field; the current state is always read from `head_snapshot`.
2. Commits at index 1 and beyond carry a `delta`. Each field in `delta.set` holds the complete value of that field as it existed in that commit. `delta.unset` lists fields that were absent or empty in that commit.
3. The oldest commit (`parent: null`) always carries a full-snapshot `delta` with all initially populated fields in `delta.set`. This serves as the reconstruction baseline. Its `changed` field lists all initially populated fields.
4. To reconstruct the snapshot at any commit: start from `head_snapshot` and for each commit from index 1 onward (newest to oldest), apply that commit's `delta` — overwriting fields in `delta.set` and clearing fields in `delta.unset` — until the target commit is reached.
5. Max commits = 10 (drop oldest on overflow, FIFO). When the oldest commit is dropped, reconstruct the full snapshot at the new oldest commit and update its `delta.set` to contain all field values at that point. This ensures the new oldest commit continues to serve as the reconstruction baseline.

### 8.4 Dedup Behavior

On save:

1. Compute new content hash (no timestamp).
2. If hash equals current head hash, no-op (do not append commit).

### 8.5 Restore Behavior

1. Find target commit by hash. If not found, return `CommitNotFound`.
2. If target hash equals the current `head`, print a message that the entry is already at the requested commit and exit without changes.
3. Reconstruct target snapshot by applying deltas backward from `head_snapshot` through each intermediate commit until the target is reached (per §8.3 rule 4).
4. Create new HEAD commit with the reconstructed target snapshot and a fresh timestamp. The new HEAD hash is the content hash of the restored snapshot.
5. Preserve old commits (non-destructive history extension). If the new commit causes history to exceed 10 commits, drop the oldest using FIFO and update the new oldest commit's `delta.set` to its full snapshot (per §8.3 rule 5).

### 8.6 Diff Accuracy Improvements

To improve change detection and history quality, implement semantic diff rules:

1. Canonicalize before diff:
   - Stable object key ordering.
   - Normalize whitespace where appropriate.
   - Normalize array ordering for fields where order is not semantically important.

2. Field-specific diff strategies:
   - `notes`: line-based diff (word-based for short values).
   - `customFields`: match by stable `id`, not by array index.
   - `tags`, `urls`, `totpSecrets`: set-style diff (`added`, `removed`) instead of whole-field replace.

3. Store structured delta in commits:
   - `delta.set` always stores the complete field value (not a partial patch), ensuring reconstruction from any point without chaining fine-grained patches.
   - `changed[]` serves as a human-readable summary. For display, derive `added`/`removed` annotations from comparing delta values. Do not store partial-patch operations as the reconstruction delta format.

4. Semantic equality rules:
   - Case-insensitive compare for tags/domains; define the exact policy as a named code-level constant.
   - URL normalization policy: lowercase host, strip trailing slash. Apply before compare.
   - Unicode NFC normalization applied to all text fields before compare and storage.

5. Field-level hashing:
   - Compute and store field hashes for tracked fields in commit metadata.
   - Continue storing top-level commit hash for identity.

## 9. Pass-Style CLI Design

### 9.1 How CLI Reads TOML Config

Config load order (first match wins):

1. `--config <path>` global CLI option.
2. `SECBITS_CONFIG` environment variable.
3. Default path: `~/.config/secbits/config.toml`.

Read/validation flow:

1. Resolve config path using load order above.
2. Read file bytes from disk.
3. Parse TOML into typed config struct.
4. Validate required fields:
   - `root_master_key_b64` and `db_path` for all commands.
   - At least one `[targets.<name>]` section for backup commands.
5. Expand `~` in paths and normalize `db_path`.
6. Return explicit error (`ConfigFileNotFound` or `InvalidConfigField`) on failure.

Operational notes:

1. All commands read config at startup.
2. `backup pull --target <name>` and `backup push --target <name>` require that target to exist in `[targets.<name>]`.
3. `backup push --all` requires at least one configured target.

### 9.2 Path Resolution (Fuzzy Matching)

#### 9.2.1 Design and Goals

Path-oriented commands support fuzzy matching against `entries.path_hint`.

Case-smart matching: if the query contains any uppercase letter, matching is case-sensitive; otherwise it is case-insensitive.

Design goals:

1. Keep pass-style UX fast for users who remember partial paths.
2. Preserve deterministic behavior for scripts and automation.
3. Fail safely on ambiguous input instead of guessing.
4. Keep path metadata matching local-only with no external process dependency.

Matching rules:

1. If input exactly matches one `path_hint`, use it directly.
2. Otherwise treat input as a case-smart regex query over full path strings.
3. If regex is invalid, fall back to literal substring matching with case-smart behavior.
4. Match output ordering is deterministic (lexicographic `path_hint`).

Ambiguity handling:

1. No match: return `PathNotFound`.
2. One match: proceed with that entry.
3. Multiple matches: return `PathAmbiguous` and print up to 20 candidate paths. If more than 20 candidates match, display the first 20 and indicate the total count.

Scope:

1. Applies to: `show`, `edit`, `rm`, `history`, `restore`.
2. `insert` requires an exact new path and must reject on an exact existing path (`PathAlreadyExists`).

#### 9.2.2 Implementation Plan (Dependencies and Algorithm)

Implementation approach:

1. Fetch candidate paths from SQLite:
   - Exact check first: `SELECT path_hint FROM entries WHERE path_hint = ? LIMIT 2`.
   - If no exact match, fetch candidate set (full list or prefix-filtered list) ordered by `path_hint`.
2. Build matcher using case-smart mode (uppercase in query → case-sensitive, else case-insensitive):
   - Try compiling query as regex.
   - If regex compile fails, escape query and use literal substring matching.
3. Filter candidates in memory and collect matches.
4. Decide outcome:
   - `0` matches => `PathNotFound`
   - `1` match => resolved `path_hint`
   - `>1` matches => `PathAmbiguous` with sorted candidates (capped at 20 for display)

Dependency decision:

1. No external binary dependency is required (do not shell out to `rg`).
2. No new system/native libraries are required.
3. Recommended crate dependency: `regex` for reliable regex compilation and matching.
4. Implementing only exact and substring matching (without regex) would not meet the full matching specification in §9.2.1.

#### 9.2.3 `path_hint` Format Rules

Valid `path_hint` values must satisfy:

1. Non-empty string.
2. No leading or trailing `/`.
3. No consecutive `/` (no empty path segments).
4. Only printable ASCII characters (codepoints 0x20–0x7E); `/` is the only reserved separator.
5. Maximum 512 characters.
6. Recommended segment pattern: `[a-z0-9][a-z0-9._-]*`, with segments separated by `/`.

`insert` validates the new path against these rules before writing. Return `InvalidPathHint` on violation.

### 9.3 Command Set

1. `secbits init --username <name>`
   - Creates user row if missing.
   - Prompts for root master key.
   - Creates and stores wrapped `user_master_key` blob.

2. `secbits login --username <name>`
   - Reads root master key from config.
   - Verifies/decrypts user master key from stored blob.
   - Prints confirmation. Does not create persistent session state.

3. `secbits ls [prefix]`
   - List `path_hint` values, optionally filtered by prefix.

4. `secbits show <path>`
   - Resolve `<path>` with fuzzy matcher to one entry.
   - Unwrap `entry_key`, decrypt `value`, and read history.
   - Print latest snapshot.

5. `secbits insert <path>`
   - Reject if path format is invalid (`InvalidPathHint`) or path already exists (`PathAlreadyExists`).
   - Read secret fields from prompt/editor.
   - Create doc key, wrapped `entry_key`, and encrypted `value`.

6. `secbits edit <path>`
   - Resolve `<path>` with fuzzy matcher to one entry.
   - Decrypt latest snapshot.
   - Edit fields.
   - Append commit if changed.

7. `secbits rm <path>`
   - Resolve `<path>` with fuzzy matcher to one entry.
   - Delete by resolved `path_hint` after confirmation.

8. `secbits history <path>`
   - Resolve `<path>` with fuzzy matcher to one entry.
   - Print commits: hash, parent, timestamp, changed fields.

9. `secbits restore <path> --commit <hash>`
   - Resolve `<path>` with fuzzy matcher to one entry.
   - Apply restore flow and persist new history blob.

10. `secbits logout`
    - Prints a message that all session state is per-invocation and already cleared at process exit.

11. `secbits backup push [--target <name> | --all]`
    - One of `--target <name>` or `--all` must be provided; invoking with neither flag is an error.
    - Creates encrypted snapshot of local DB and uploads to one selected backup target or all configured targets.
    - Object key format per target: `<prefix><username>/<timestamp_utc_iso8601>.secbits.enc`.

12. `secbits backup pull --target <name> [--object <key>]`
    - Downloads latest (or specified) encrypted backup object from the selected backup target.
    - "Latest" is determined by listing objects under `<prefix><username>/` and selecting the lexicographically largest key (ISO-8601 timestamps sort correctly this way).
    - Verifies/decrypts using `root_master_key_b64` and restores local DB after confirmation.

## 10. Authentication and Session Semantics

The CLI is stateless across invocations. Each process invocation reads the root master key from config, performs its work, and zeroizes all key material before exit.

1. The root master key is read from the TOML config on every command startup.
2. Every command that requires decryption automatically verifies the root master key against the stored user master key blob before proceeding. If verification fails, the command returns `WrongRootMasterKey`.
3. The decrypted user master key is held only in process memory for the duration of the command invocation.
4. On process exit, best-effort zeroization of all in-memory sensitive buffers.
5. Never persist the decrypted user master key to disk.
6. Commands that require decryption must fail with a clear message if no user record exists for the configured username (`UserNotFound`).

`login` semantics: Verifies the root master key in config against the stored user master key blob and prints confirmation. Serves as an explicit verification step; does not create persistent session state.

`logout` semantics: No-op. All sensitive state is per-invocation and zeroized at process exit. Kept for UX familiarity.

Optional future enhancement: short-lived encrypted session token in OS keyring. If adopted, this is an explicit change to the session model that must be documented and reviewed separately; the encrypted token must not be usable to reconstruct the user master key without the root master key.

## 11. Error Model

Representative errors:

1. `InvalidRootMasterKeyFormat`
2. `RootMasterKeyTooShort`
3. `WrongRootMasterKey`
4. `UserNotFound`
5. `InvalidStoredUserMasterKeyBlob`
6. `InvalidEntryKeyBlob`
7. `DecryptionFailedAuthentication`
8. `PathAlreadyExists`
9. `PathNotFound`
10. `PathAmbiguous`
11. `InvalidPathHint`
12. `CommitNotFound`
13. `HistoryCorrupted`
14. `ConfigFileNotFound`
15. `InvalidConfigField`
16. `BackupUploadFailed`
17. `BackupDownloadFailed`
18. `BackupDecryptFailed`
19. `BackupRestoreFailed`
20. `BackupTargetNotConfigured`

All crypto/auth errors should be explicit and non-ambiguous for operators.

## 12. Security Controls

1. Zeroize sensitive byte buffers (`zeroize` crate).
2. Avoid logging secret fields, raw blobs, or keys.
3. Use constant-time comparisons where relevant.
4. Disable core dumps in production guidance where feasible.
5. Restrict database file permissions (`0600`).
6. `path_hint` is metadata, not secret; all secret material stays encrypted in `entry_key` and `value`.
7. Encrypt cloud backup payloads before upload; never upload plaintext SQLite files.
8. Use server-side TLS and object-store IAM scoped to backup bucket/prefix only.

## 13. Dependency Plan

Rust crates (initial):

1. `clap` for CLI.
2. `rusqlite` for SQLite.
3. `serde` + `serde_json` for history serialization.
4. `base64` for root key decoding.
5. `sha2` (or compatible) for commit hash (SHA-256).
6. `rand` / `getrandom` for secure randomness.
7. `zeroize` for key material cleanup.
8. `thiserror` / `anyhow` for error handling.
9. FFI binding crate(s) for leancrypto and brotli system libs.
10. `toml` for CLI config parsing.
11. S3-compatible client crate (`aws-sdk-s3` or equivalent with custom endpoint support).
12. `regex` for path query matching (smart-case regex + literal fallback).
13. Optional: `url` and Unicode normalization crate for semantic diff normalization rules.

## 14. FFI Integration Strategy

### 14.1 Leancrypto

Implement a safe wrapper layer that exposes:

1. `hkdf_sha3_512(ikm, salt) -> (enc_key[64], enc_iv[64])`
2. `aead_encrypt(enc_key, enc_iv, plaintext) -> (ciphertext, tag[64])`
3. `aead_decrypt(enc_key, enc_iv, ciphertext, tag) -> plaintext | auth error`

Wrapper responsibilities:

1. Own all raw pointers.
2. Free all allocated memory in all paths.
3. Map leancrypto rc codes to Rust error types.
4. Unit-test pointer safety and round-trips.

### 14.2 Brotli

Provide:

1. `compress(bytes) -> bytes`
2. `decompress(bytes) -> bytes`

Use system brotli libs through FFI crate or direct bindings.

## 15. Detailed Command Flow Examples

### 15.1 `insert`

1. Verify root master key from config against stored user master key blob; derive user master key. Return `UserNotFound` if no user record exists.
2. Validate `path_hint` format per §9.2.3. Return `InvalidPathHint` on violation.
3. Check `path_hint` uniqueness. Return `PathAlreadyExists` if it already exists.
4. Build entry payload fields with current timestamp.
5. Generate `doc_key` (64 random bytes).
6. Build initial commit:
   - `parent = null`.
   - `timestamp` = current UTC ISO-8601 timestamp.
   - `changed` = list of all non-empty fields in the initial snapshot.
   - `hash` = content hash of the initial snapshot (per §8.1).
   - `delta.set` = all initially populated field values (serves as the reconstruction baseline per §8.3 rule 3).
   - `delta.unset` = all fields absent or empty in the initial snapshot.
7. Build compact history object: `{ "head": <hash>, "head_snapshot": <snapshot>, "commits": [<initial_commit>] }`.
8. Serialize history JSON.
9. Brotli compress serialized JSON.
10. Encrypt compressed history with `doc_key` via `encryptBytesToBlob` => `value` blob.
11. Wrap `doc_key` with user master key via `encryptBytesToBlob` => `entry_key` blob.
12. Write row with `entry_key = entry_key_blob` and `value = value_blob`.

### 15.2 `show`

1. Verify root master key from config; derive user master key.
2. Resolve user-provided `<path>` via fuzzy matcher to one `path_hint`.
3. Load row by resolved `path_hint`.
4. Unwrap `doc_key` via `decryptBytesFromBlob(user_master_key, entry_key)`.
5. Decrypt `value` via `decryptBytesFromBlob(doc_key, value)` into compressed history bytes.
6. Brotli decompress and parse JSON into compact history object.
7. Render `head_snapshot` as the latest entry state.

### 15.3 `backup push`

Backup encryption key derivation:

- Generate fresh random `backup_salt` (64 bytes).
- Derive `(backup_enc_key[64], backup_enc_iv[64])` = `hkdf_sha3_512(ikm=root_master_key, salt=backup_salt)`.
- Backup blob layout: `backup_salt || ciphertext || tag` (same structure as §6.4).

Steps:

1. Verify root master key from config.
2. Resolve upload targets from `--target <name>` or `--all`. If neither flag is provided, return `InvalidConfigField`. If `--all` and no targets are configured, return `BackupTargetNotConfigured`.
3. Read `db_path` as raw bytes.
4. Generate `backup_salt`; derive `backup_enc_key` and `backup_enc_iv`.
5. AEAD-encrypt and authenticate DB bytes with `(backup_enc_key, backup_enc_iv)`.
6. Assemble backup blob: `backup_salt || ciphertext || tag`.
7. Upload backup blob to each selected S3-compatible backend.
8. Object key format: `<prefix><username>/<timestamp_utc_iso8601>.secbits.enc`.
9. Return per-target object key and checksum on success; return `BackupUploadFailed` on failure.

### 15.4 `backup pull --target <name>`

Safe replace flow: write decrypted DB bytes to a temporary file in the same directory as `db_path` (e.g., `<db_path>.tmp`); on success, rename the temp file to `db_path` (atomic POSIX rename); on any failure, delete the temp file and return `BackupRestoreFailed` without modifying the existing `db_path`.

Steps:

1. Verify root master key from config.
2. Resolve selected target profile from `--target`. Return `BackupTargetNotConfigured` if not found.
3. Resolve backup object key:
   - If `--object <key>` is provided, use it directly.
   - Otherwise list objects under `<prefix><username>/` and select the lexicographically largest key.
4. Download encrypted backup blob from the selected backend. Return `BackupDownloadFailed` on failure.
5. Parse blob: `backup_salt = blob[0..64]`, `ciphertext = blob[64..len-64]`, `tag = blob[len-64..len]`.
6. Re-derive `(backup_enc_key, backup_enc_iv)` from `(root_master_key, backup_salt)`.
7. AEAD-decrypt and authenticate. Return `BackupDecryptFailed` on failure.
8. Warn the user that local entries not present in the backup will be permanently lost. Require explicit confirmation before proceeding.
9. Write restored DB bytes using the safe replace flow described above. Return `BackupRestoreFailed` on any write/rename failure.
10. Print confirmation with the restored object key and size.

### 15.5 `edit`

1. Verify root master key from config; derive user master key.
2. Resolve `<path>` via fuzzy matcher to one `path_hint`.
3. Load row; unwrap `doc_key` via `decryptBytesFromBlob`; decrypt and decompress history.
4. Present current snapshot fields for interactive editing.
5. Compute new content hash of the edited snapshot.
6. If hash equals current head hash, no-op (dedup; print message).
7. Build new commit: `hash = <new_hash>`, `parent = current head`, `timestamp = now`, `changed = <diffed fields>`.
8. Build delta for the prior HEAD (now the second commit): `delta.set` = complete values of all fields in the prior HEAD snapshot; `delta.unset` = fields absent in the prior HEAD snapshot.
9. Update `head_snapshot` to the new snapshot. Prepend new commit to `commits`.
10. If `commits.len() > 10`, drop oldest commit (FIFO) and update the new oldest commit's `delta.set` to its full snapshot.
11. Serialize, brotli compress, and re-encrypt history with `doc_key` via `encryptBytesToBlob`.
12. Update row: `value = new_value_blob`.

### 15.6 `history`

1. Verify root master key from config; derive user master key.
2. Resolve `<path>` via fuzzy matcher to one `path_hint`.
3. Load row; unwrap `doc_key`; decrypt and decompress history.
4. Print each commit in order (newest first): hash, parent, timestamp, changed fields.

### 15.7 `restore`

1. Verify root master key from config; derive user master key.
2. Resolve `<path>` via fuzzy matcher to one `path_hint`.
3. Load row; unwrap `doc_key`; decrypt and decompress history.
4. Find commit by `--commit <hash>`. Return `CommitNotFound` if not present.
5. If target hash equals current `head`, print "Already at requested commit" and exit without changes.
6. Reconstruct target snapshot: starting from `head_snapshot`, apply each commit's `delta` backward (overwrite with `delta.set` values, clear `delta.unset` fields) until the target commit is reached.
7. Build new HEAD commit: `hash = content_hash(target_snapshot)`, `parent = current head`, `timestamp = now`, `changed = fields that differ between target snapshot and current head_snapshot`.
8. Build delta for the prior HEAD (now the second commit): `delta.set` = complete values of all fields in the prior HEAD snapshot.
9. Update `head_snapshot = target_snapshot`. Prepend new HEAD to `commits`. If `commits.len() > 10`, drop oldest (FIFO) and update new oldest's `delta.set` to its full snapshot.
10. Serialize, compress, and re-encrypt. Update row: `value = new_value_blob`.

### 15.8 `rm`

1. Verify root master key from config (confirms the user is authorized).
2. Resolve `<path>` via fuzzy matcher to one `path_hint`.
3. Print resolved `path_hint` and prompt for confirmation: "Delete `<path_hint>`? [y/N]".
4. On confirmation, delete the row by resolved `path_hint`. The `ON DELETE CASCADE` constraint removes all associated columns.
5. Print deletion confirmation.

### 15.9 `logout`

1. Print: "SecBits uses a per-invocation session model. All key material is held only in process memory and is zeroized at process exit. No persistent session state exists to clear."
2. Exit with success.

## 16. Testing Strategy

### 16.1 Unit Tests

1. Root key validation (valid, too short, invalid base64).
2. Blob layout parse/encode for user master key blobs.
3. `encryptBytesToBlob` / `decryptBytesFromBlob` round-trip; verify each call produces a distinct salt and ciphertext.
4. User master key setup/verify.
5. Entry key wrap/unwrap.
6. History encrypt/decrypt round-trip.
7. Commit hash/dedup correctness.
8. Delta construction, reconstruction, and restore.
9. Canonicalization and semantic equality rules for diffing.
10. Field-level hash stability and change detection.
11. Initial commit structure: single-commit history has `parent: null`, `changed` lists all populated fields, `delta.set` contains all initial field values, HEAD commit has no `delta`.
12. Commit overflow: inserting an 11th change drops the oldest commit; resulting `commits.len() == 10`; new oldest commit's `delta.set` contains its full snapshot.
13. Restore to HEAD: target hash equals current head, no-op, history unchanged.
14. Diff test corpus:
    - Array reorder without semantic change.
    - Whitespace-only edits.
    - `customFields` reorder vs true content change.
    - URL normalization equivalence cases.
    - Unicode NFC normalization edge cases.

### 16.2 Negative Tests

1. Wrong root key rejects verify (`WrongRootMasterKey`).
2. Tampered tag rejects decrypt (`DecryptionFailedAuthentication`).
3. Corrupted `entry_key` blob fails unwrap.
4. Corrupted history JSON fails safely (`HistoryCorrupted`).
5. User master key blob too short (e.g., 100 bytes) returns `InvalidStoredUserMasterKeyBlob`.
6. User master key blob too long (e.g., 200 bytes) returns `InvalidStoredUserMasterKeyBlob`.
7. `restore --commit <unknown_hash>` returns `CommitNotFound`.
8. `insert` with invalid `path_hint` (empty string, leading slash, consecutive slashes) returns `InvalidPathHint`.
9. `backup push` with no `--target` or `--all` flag returns an error.
10. `backup push --all` with zero configured targets returns `BackupTargetNotConfigured`.
11. Config file present but missing `db_path` returns `InvalidConfigField`.
12. Config file present but missing `root_master_key_b64` returns `InvalidConfigField`.
13. Login for a username not in the database returns `UserNotFound`.

### 16.3 Integration Tests

1. `init -> login -> insert -> show -> edit -> history -> restore`.
2. Multi-entry pass-style path listing.
3. DB persistence across process restarts.
4. `backup push -> delete local db copy -> backup pull` disaster-recovery path.
5. Multi-target push (`--all`) and provider-selective pull (`--target r2|aws|gcs`) coverage.
6. Diff behavior on reorder/whitespace/normalization scenarios.
7. Commit overflow: apply 11 distinct edits to one entry; verify history length is exactly 10 and oldest commit's `delta.set` reflects its full snapshot.
8. `backup pull` overwrites local DB; verify the confirmation prompt and that cancellation leaves the existing DB intact.

### 16.4 End-to-End and CLI Contract Tests

1. Snapshot-test human-readable CLI output format for `ls`, `show`, `history`, and errors.
2. Validate CLI exit codes for success, validation failures, auth failures, and crypto failures.
3. Verify backward-compatible behavior for key command flags (`--config`, `--target`, `--all`, `--commit`).

### 16.5 Test Execution Plan

1. On every pull request:
   - Run formatting and lint checks.
   - Run all unit tests and negative tests.
2. On merge to main:
   - Run full integration suite including backup round-trip tests.
   - Run selected deterministic end-to-end CLI contract tests.
3. Before release:
   - Run full suite on a clean environment with a fresh database path.
   - Run disaster-recovery scenario (`backup push` + local DB removal + `backup pull`).

### 16.6 Quality Gates

1. No failing tests in unit, integration, or CLI contract suites.
2. All critical security invariants validated by tests (auth failures, tag tamper rejection, key unwrap failures).
3. No unresolved high-severity defects in auth, encryption, or backup restore flows.
4. Documentation and command help text match implemented behavior.

## 17. Implementation Plan and Milestones

### 17.1 Milestone 1: Foundation and Project Skeleton

**Goal:** Create a buildable, testable Rust CLI baseline with module boundaries.

**Scope:** Workspace bootstrap, CLI command wiring, error type scaffolding, logging policy.

**Exit criteria:**
1. `secbits --help` shows full command surface.
2. Basic CI checks and test harness run successfully.

### 17.2 Milestone 2: Storage Layer and Migrations

**Goal:** Establish stable local persistence for users and entries.

**Scope:** SQLite connection lifecycle, schema creation, migration runner using `PRAGMA user_version`, repository layer.

**Exit criteria:**
1. Fresh DB bootstraps automatically.
2. CRUD storage tests pass for users and entries.

### 17.3 Milestone 3: Crypto and Compression Core

**Goal:** Implement production-safe cryptographic and compression primitives.

**Scope:** leancrypto wrappers, brotli wrappers, `encryptBytesToBlob` / `decryptBytesFromBlob` codec, zeroization hooks.

**Exit criteria:**
1. Encrypt/decrypt round-trip tests pass.
2. Tamper/auth-failure tests pass.

### 17.4 Milestone 4: Authentication Lifecycle

**Goal:** Support secure root master key validation and user master key lifecycle.

**Scope:** `init`, `login`, per-invocation session semantics, auth-related error mapping.

**Exit criteria:**
1. Correct key setup/verification behavior validated by unit and integration tests.
2. Wrong root key reliably fails with explicit error.

### 17.5 Milestone 5: Entry History Engine

**Goal:** Deliver robust entry storage with commit history semantics.

**Scope:** `entry_key` wrapping, encrypted history payload, commit hash, dedup, restore, structured deltas, commit overflow handling.

**Exit criteria:**
1. History reconstruction and restore tests pass.
2. Dedup behavior verified across unchanged updates.
3. Commit overflow (>10) correctly drops oldest and updates new oldest commit's delta.

### 17.6 Milestone 6: Path UX and Core Commands

**Goal:** Provide complete pass-style command workflows with fuzzy path resolution.

**Scope:** `ls/show/insert/edit/rm/history/restore/logout`, path matcher, ambiguity handling, `path_hint` format validation.

**Exit criteria:**
1. Core workflow integration tests pass.
2. Path resolution behavior meets §9.2 design and implementation rules.
3. `InvalidPathHint` validation enforced on `insert`.

### 17.7 Milestone 7: Config and Backup Targets

**Goal:** Enable deterministic TOML-driven runtime config and encrypted backups.

**Scope:** Config load order/validation, backup push/pull with key derivation per §15.3, safe replace flow per §15.4, multi-target selection logic.

**Exit criteria:**
1. Backup round-trip tests pass for selected target and `--all`.
2. Disaster-recovery scenario passes.
3. `backup pull` safe replace is atomic; partial failure leaves existing DB intact.

### 17.8 Milestone 8: Diff Accuracy and Quality Hardening

**Goal:** Improve diff precision and finalize operational quality.

**Scope:** Canonicalization rules, semantic diff logic, field-level hashes, error-hardening.

**Exit criteria:**
1. Diff normalization and structured-delta tests pass.
2. No unresolved critical defects in security-sensitive paths.

### 17.9 Milestone 9: Release Readiness

**Goal:** Ship a documented, reproducible CLI release.

**Scope:** Packaging, operational docs, command examples, final verification matrix.

**Exit criteria:**
1. All quality gates in §16.6 pass.
2. Release artifact and documentation are complete.

## 18. Open Decisions (Track Explicitly)

### 18.1 Path Uniqueness Scope

Question: Should `path_hint` uniqueness be global or per-user?

Current default: Global uniqueness (`UNIQUE(path_hint)`). If switched to per-user, change the constraint to `UNIQUE(user_id, path_hint)` and update `ls` and all path resolution queries to filter by the active user.

Alternative: Per-user uniqueness with `UNIQUE(user_id, path_hint)`.

### 18.2 TOTP Helper Command

Question: Should TOTP generation be included in CLI output helpers?

Current default: Keep model support only; add `totp <path>` command surface later if required.

### 18.3 Import and Export

Question: Should JSON import/export be included?

Current default: Keep as a future enhancement.

### 18.4 Backup Scheduling

Question: Should backups be manual only or allow timer-based automation?

Current default: Manual by default.

## 19. Minimal Acceptance Criteria

1. Can create user and verify root master key offline.
2. Can insert/show/edit/remove entries by pass-style path.
3. Entry data at rest is encrypted and authenticated.
4. History supports dedup, listing, and restore.
5. All crypto invariants match this document.
6. Can push encrypted backups to one or all configured backup targets.
7. Can pull encrypted backups from a chosen backup target.

## 20. Summary

This design defines a Rust-native offline SecBits with:

1. Strict retention of existing enc/dec/auth behavior.
2. SQLite-backed local persistence with version-tracked schema migrations.
3. Pass-style path UX with fuzzy matching.
4. TOML-driven CLI configuration (root key, db path, backup targets).
5. Multi-target encrypted backup support for R2/GCS/AWS S3 in one config.
6. A detailed, testable implementation plan for starting from an empty repository state.
