# SecBits

This document is the full implementation design for rebuilding SecBits as an offline-first Rust application from an empty repository state.

It is intentionally detailed and prescriptive so implementation can start immediately without referencing the prior JavaScript codebase.

## 1. Objectives

1. Build a local/offline password manager in Rust.
2. Preserve the existing encryption, decryption, and authentication/key-lifecycle model.
3. Use system-installed libraries:
- leancrypto (for HKDF-SHA3-512 + Ascon-Keccak-512 AEAD)
- brotli (for pre-encryption compression)
- sqlite (for local storage)
4. Mimic pass-style UX with path-oriented entries.
5. Keep commit-history semantics compatible with current logic (hashing, dedup, restore, compact history object).
6. Support encrypted cloud backups through S3-compatible object storage.

## 2. Non-Goals

1. No Firebase integration.
2. No browser UI in phase 1.
3. No automatic multi-device cloud sync in phase 1.
4. No format migration tooling in phase 1 unless explicitly added later.

## 3. Runtime and Toolchain

1. Rust stable (target edition: 2021 or newer).
2. Linux-first implementation.
3. Dynamic linking to system libraries:
- libsqlite3
- libbrotlienc + libbrotlidec
- libleancrypto (or project-local build artifact if system package is unavailable)

## 4. High-Level Architecture

Single binary CLI:

- `secbits` command with subcommands.
- Local database file (default: `~/.local/share/secbits/secbits.db`).
- TOML config file (default: `~/.config/secbits/config.toml`).
- Session state contains decrypted User Master Key only in process memory.

Internal modules:

1. `cli`
- argument parsing
- interactive prompts
- command routing

2. `db`
- sqlite connection lifecycle
- schema migrations
- CRUD for users/entries

3. `crypto`
- thin safe wrappers around leancrypto FFI
- byte layout encode/decode
- zeroization helpers

4. `compression`
- brotli encode/decode wrappers

5. `model`
- entry payload structs
- history structs
- delta reconstruction

6. `app`
- domain flows (login/init/insert/show/edit/history/restore)

7. `backup`
- cloud backup pack/unpack
- S3-compatible upload/download flows

## 4.1 CLI TOML Config

Config file format: TOML.

```toml
root_master_key_b64 = "BASE64_ROOT_MASTER_KEY"
db_path = "/home/user/.local/share/secbits/secbits.db"

[clouds.r2]
provider = "r2"
endpoint = "https://<account>.r2.cloudflarestorage.com"
region = "auto"
bucket = "secbits-backups-r2"
prefix = "prod/"
access_key_id = "..."
secret_access_key = "..."
session_token = "" # optional

[clouds.aws]
provider = "aws"
region = "us-east-1"
bucket = "secbits-backups-aws"
prefix = "prod/"
access_key_id = "..."
secret_access_key = "..."
session_token = "" # optional

[clouds.gcs]
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
3. `[clouds.<name>]` defines one or more S3-compatible cloud targets, allowing R2, AWS S3, and GCS to be configured at the same time.
4. `provider` identifies behavior differences (`r2`, `aws`, `gcs`) while still using S3 API-compatible upload/download flows.
5. Secrets in config must be protected by filesystem permissions (`0600`) or environment override strategy.

## 5. SQLite Schema

Exact schema requested:

```sql
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

## 6. Cryptographic Invariants (Must Match Existing Design)

Constants:

- `SALT_LEN = 64`
- `USER_MASTER_KEY_LEN = 64`
- `DOC_KEY_LEN = 64`
- `ENC_KEY_LEN = 64`
- `ENC_IV_LEN = 64`
- `TAG_LEN = 64`
- `HKDF_OUT_LEN = 128`
- `MASTER_BLOB_LEN = 192`

Algorithms:

1. HKDF with SHA3-512 via leancrypto.
2. AEAD Ascon-Keccak-512 via leancrypto.
3. Brotli compression before encrypting entry history.
4. Blob layout: `salt || ciphertext || tag`.

### 6.1 Root Master Key Validation

Input root key is base64 text.

Validation rules:

1. Must decode successfully.
2. Decoded length must be `>= 256` bytes.
3. Else fail fast with explicit error.

### 6.2 User Master Key Setup (First Login)

1. Generate random `user_master_key` (64 bytes).
2. Generate random `salt` (64 bytes).
3. Derive `{encKey, encIv}` from `root_master_key + salt` using HKDF-SHA3-512.
4. AEAD-encrypt `user_master_key` using `{encKey, encIv}` with 64-byte tag.
5. Persist `user_master_key_blob = salt || encrypted_user_master_key || tag` (192 bytes).
6. Keep plaintext user master key in memory only.

### 6.3 User Master Key Verify (Returning Login)

1. Load stored blob from `users.user_master_key`.
2. Validate blob size = 192 bytes.
3. Parse:
- `salt = blob[0..64]`
- `enc_user_master_key = blob[64..128]`
- `tag = blob[128..192]`
4. Re-derive `{encKey, encIv}` from root key + salt.
5. AEAD-decrypt and authenticate.
6. On auth failure: return `Wrong root master key`.

## 7. Data-at-Rest Columns in `entries`

`entries` stores wrapped key and encrypted payload in separate columns:

1. `entry_key = encryptBytesToBlob(user_master_key, doc_key)`
2. `value = encryptBytesToBlob(doc_key, brotli(JSON(history_object)))`

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

- `title, username, password, notes, urls, totpSecrets, customFields, tags`

### 8.1 Commit Hash

1. Build content object excluding `timestamp`.
2. Stable top-level key ordering.
3. SHA-256 digest.
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
    { "hash": "f7e8d9c0b1a2", "parent": null, "timestamp": "...", "changed": [], "delta": { "set": { "password": "old" }, "unset": [] } }
  ]
}
```

Rules:

1. `commits[0]` is HEAD metadata.
2. Older commits may carry `delta` relative to newer snapshot.
3. Reconstruct snapshots in memory when listing history/showing diff.
4. Max commits = 10 (drop oldest on overflow).

### 8.4 Dedup Behavior

On save:

1. Compute new content hash (no timestamp).
2. If hash equals current head hash, no-op (do not append commit).

### 8.5 Restore Behavior

1. Find target commit by hash.
2. Create new HEAD commit with target snapshot and fresh timestamp.
3. Preserve old commits (non-destructive history extension).

## 9. Pass-Style CLI Design

Command set (phase 1):

1. `secbits init --username <name>`
- Creates user row if missing.
- Prompts for root master key.
- Creates and stores wrapped `user_master_key` blob.

2. `secbits login --username <name>`
- Prompts for root master key.
- Verifies/decrypts user master key into session memory.

3. `secbits ls [prefix]`
- List `path_hint` values, optionally filtered by prefix.

4. `secbits show <path>`
- Lookup row by `path_hint`.
- Unwrap `entry_key`, decrypt `value`, and read history.
- Print latest snapshot.

5. `secbits insert <path>`
- Reject if path exists.
- Read secret fields from prompt/editor.
- Create doc key, wrapped `entry_key`, and encrypted `value`.

6. `secbits edit <path>`
- Decrypt latest snapshot.
- Edit fields.
- Append commit if changed.

7. `secbits rm <path>`
- Delete by `path_hint` after confirmation.

8. `secbits history <path>`
- Print commits: hash, parent, timestamp, changed fields.

9. `secbits restore <path> --commit <hash>`
- Apply restore flow and persist new history blob.

10. `secbits logout`
- Explicitly zeroize in-memory user master key.

11. `secbits backup push [--cloud <name>|--all]`
- Create encrypted snapshot of local DB and upload to one selected cloud target or all configured targets.
- Object key format per cloud: `<prefix><username>/<timestamp>.secbits.enc`.

12. `secbits backup pull --cloud <name> [--object <key>]`
- Download latest (or specified) encrypted backup object from the selected cloud target.
- Verify/decrypt using `root_master_key_b64` and restore local DB after confirmation.

## 10. Authentication and Session Semantics

1. Session key is process memory only.
2. Never persist decrypted user master key to disk.
3. On process exit, best-effort zeroization.
4. Commands that require decryption must fail with clear message if not logged in.

Optional phase 2:

- short-lived encrypted session token in OS keyring.

## 11. Error Model

Representative errors:

1. `InvalidRootMasterKeyFormat`
2. `RootMasterKeyTooShort`
3. `WrongRootMasterKey`
4. `InvalidStoredUserMasterKeyBlob`
5. `InvalidEntryKeyBlob`
6. `DecryptionFailedAuthentication`
7. `PathAlreadyExists`
8. `PathNotFound`
9. `HistoryCorrupted`
10. `ConfigFileNotFound`
11. `InvalidConfigField`
12. `BackupUploadFailed`
13. `BackupDownloadFailed`
14. `BackupDecryptFailed`
15. `BackupCloudNotConfigured`

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
5. `sha2` (or compatible) for commit hash.
6. `rand` / `getrandom` for secure randomness.
7. `zeroize` for key material cleanup.
8. `thiserror` / `anyhow` for error handling.
9. FFI binding crate(s) for leancrypto and brotli system libs.
10. `toml` for CLI config parsing.
11. S3-compatible client crate (`aws-sdk-s3` or equivalent with custom endpoint support).

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

1. Ensure logged in and session has user master key.
2. Validate `path_hint` uniqueness.
3. Build entry payload with current timestamp.
4. Generate `doc_key` (64 random bytes).
5. Build history object with initial commit.
6. Serialize history JSON.
7. Brotli compress JSON.
8. Encrypt compressed history with `doc_key` => `history_blob`.
9. Wrap `doc_key` with user master key => `entry_key_blob`.
10. Write row with `entry_key = entry_key_blob` and `value = history_blob`.

### 15.2 `show`

1. Ensure logged in.
2. Load row by `path_hint`.
3. Read `entry_key` and `value`.
4. Unwrap `doc_key` using user master key and `entry_key`.
5. Decrypt `value` into compressed history bytes.
6. Brotli decompress and parse JSON.
7. Reconstruct commits/snapshots.
8. Render latest snapshot.

### 15.3 `backup push`

1. Load and validate TOML config.
2. Open `db_path` and read SQLite file bytes.
3. Generate backup nonce/salt and derive backup encryption key from root master key.
4. Encrypt + authenticate backup payload.
5. Resolve upload targets from `--cloud <name>` or `--all`.
6. Upload encrypted object to each selected S3-compatible backend (R2/GCS/AWS S3).
7. Return per-cloud object key and checksum.

### 15.4 `backup pull --cloud <name>`

1. Load and validate TOML config.
2. Resolve selected cloud profile from `--cloud`.
3. Resolve backup object key (latest or explicit `--object`).
4. Download encrypted object from the selected S3-compatible backend.
5. Decrypt + authenticate with root master key.
6. Write restored SQLite bytes to `db_path` with safe replace flow.
7. Confirm restore success.

## 16. Testing Strategy

### 16.1 Unit Tests

1. Root key validation.
2. Blob layout parse/encode.
3. User master key setup/verify.
4. Entry key wrap/unwrap.
5. History encrypt/decrypt round-trip.
6. Commit hash/dedup correctness.
7. Delta reconstruction and restore.

### 16.2 Negative Tests

1. Wrong root key rejects verify.
2. Tampered tag rejects decrypt.
3. Corrupted `entry_key` blob fails unwrap.
4. Corrupted history JSON fails safely.

### 16.3 Integration Tests

1. `init -> login -> insert -> show -> edit -> history -> restore`.
2. Multi-entry pass-style path listing.
3. DB persistence across process restarts.
4. `backup push -> delete local db copy -> backup pull` disaster-recovery path.
5. Multi-cloud push (`--all`) and provider-selective pull (`--cloud r2|aws|gcs`) coverage.

## 17. Implementation Milestones

1. Bootstrap empty Rust workspace + CLI skeleton.
2. Add SQLite schema and migration runner.
3. Add leancrypto+brotli wrappers.
4. Implement auth key lifecycle (`init`, `login`).
5. Implement `entry_key` + history codec.
6. Implement CRUD and pass-style commands.
7. Implement TOML config loading and validation.
8. Implement S3-compatible cloud backup commands.
9. Implement multi-cloud profile selection logic for backup push/pull.
10. Add full test suite.
11. Harden error handling and zeroization.
12. Package and document operational setup.

## 18. Open Decisions (Track Explicitly)

1. Should `path_hint` uniqueness be global or per-user?
- Current schema makes it global due to `UNIQUE(path_hint)`.
- If per-user desired later: replace with `UNIQUE(user_id, path_hint)`.

2. Should TOTP generation be included in phase 1 CLI output helpers?
- Model supports it; command surface can add `totp <path>` later.

3. Should import/export JSON be added in phase 1?
- Recommended phase 2.

4. Backup schedule policy: manual only or optional timer-based automation?
- Default recommendation: manual in phase 1.

## 19. Minimal Acceptance Criteria

1. Can create user and verify root master key offline.
2. Can insert/show/edit/remove entries by pass-style path.
3. Entry data at rest is encrypted and authenticated.
4. History supports dedup, listing, and restore.
5. All crypto invariants match this document.
6. Can push encrypted backups to one or all configured cloud targets.
7. Can pull encrypted backups from a chosen cloud target.

## 20. Summary

This design defines a Rust-native offline SecBits with:

1. strict retention of existing enc/dec/auth behavior,
2. sqlite-backed local persistence,
3. pass-style path UX,
4. TOML-driven CLI configuration (root key, db path, cloud backend),
5. multi-cloud encrypted backup support for R2/GCS/AWS S3 in one config,
6. and a detailed, testable implementation plan for starting from an empty repository state.
