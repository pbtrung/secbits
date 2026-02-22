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
- Session state contains decrypted User Master Key only in process memory.

Internal modules:

1. `cli`: argument parsing, interactive prompts, command routing.
2. `db`: sqlite connection lifecycle, schema migrations, CRUD for users/entries.
3. `crypto`: thin safe wrappers around leancrypto FFI, byte layout encode/decode, zeroization helpers.
4. `compression`: brotli encode/decode wrappers.
5. `model`: entry payload structs, history structs, delta reconstruction.
6. `app`: domain flows (login/init/insert/show/edit/history/restore).
7. `backup`: backup pack/unpack, S3-compatible upload/download flows.

## 4.1 CLI TOML Config

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
- Keep per-field operations like `set`, `unset`, `add`, `remove`.
- Keep `changed[]` as summary, but use structured delta for accurate restore/explain.

4. Semantic equality rules:
- Case-insensitive compare for tags/domains if aligned with UX.
- URL normalization policy before compare (host case, trailing slash policy).
- Optional Unicode normalization for stable text comparisons.

5. Field-level hashing:
- Compute and store field hashes for tracked fields in commit metadata.
- Continue storing top-level commit hash for identity.

6. Test corpus for diff correctness:
- Array reorder without semantic change.
- Whitespace-only edits.
- `customFields` reorder vs true content change.
- URL normalization equivalence cases.
- Unicode normalization edge cases.

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
- `targets.<name>` or at least one target for backup commands.
5. Expand `~` in paths and normalize `db_path`.
6. Return explicit error (`ConfigFileNotFound` or `InvalidConfigField`) on failure.

Operational notes:

1. All commands read config at startup.
2. `backup pull --target <name>` and `backup push --target <name>` require that target to exist in `[targets.<name>]`.
3. `backup push --all` requires at least one configured target.

### 9.2 Path Resolution (Fuzzy, rg-like)

#### 9.2.1 Design and Goals

Path-oriented commands support fuzzy matching against `entries.path_hint` using an `rg`-style matcher.

Design goals:

1. Keep pass-style UX fast for users who remember partial paths.
2. Preserve deterministic behavior for scripts and automation.
3. Fail safely on ambiguous input instead of guessing.
4. Keep path metadata matching local-only with no external process dependency.

Matching rules:

1. If input exactly matches one `path_hint`, use it directly.
2. Otherwise treat input as a case-smart regex query over full path strings.
3. If regex is invalid, fall back to literal substring matching.
4. Match output ordering should be deterministic (lexicographic `path_hint`).

Ambiguity handling:

1. No match: return `PathNotFound`.
2. One match: proceed with that entry.
3. Multiple matches: return `PathAmbiguous` and print candidate paths for user selection/refinement.

Scope:

1. Applies to: `show`, `edit`, `rm`, `history`, `restore`.
2. `insert` still requires an exact new path and must reject on exact existing path (`PathAlreadyExists`).

#### 9.2.2 Implementation Plan (Dependencies and Algorithm)

Implementation approach:

1. Fetch candidate paths from SQLite:
- Exact check first: `SELECT path_hint FROM entries WHERE path_hint = ? LIMIT 2`.
- If no exact match, fetch candidate set (full list or prefix-filtered list) ordered by `path_hint`.
2. Build matcher:
- Smart-case mode: if query has uppercase letters, match case-sensitive; otherwise case-insensitive.
- Try compiling query as regex.
- If regex compile fails, escape query and use literal substring matching.
3. Filter candidates in memory and collect matches.
4. Decide outcome:
- `0` matches => `PathNotFound`
- `1` match => resolved `path_hint`
- `>1` matches => `PathAmbiguous` with sorted candidates

Dependency decision:

1. No external binary dependency is required (do not shell out to `rg`).
2. No new system/native libraries are required.
3. Recommended crate dependency: `regex` for reliable regex compilation and matching.
4. If you want zero extra Rust crates, you can implement only exact + substring matching, but that would no longer meet the regex part of 9.2.

### 9.3 Command Set

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
- Resolve `<path>` with fuzzy matcher to one entry.
- Unwrap `entry_key`, decrypt `value`, and read history.
- Print latest snapshot.

5. `secbits insert <path>`
- Reject if path exists.
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
- Explicitly zeroize in-memory user master key.

11. `secbits backup push [--target <name>|--all]`
- Create encrypted snapshot of local DB and upload to one selected backup target or all configured targets.
- Object key format per target: `<prefix><username>/<timestamp>.secbits.enc`.

12. `secbits backup pull --target <name> [--object <key>]`
- Download latest (or specified) encrypted backup object from the selected backup target.
- Verify/decrypt using `root_master_key_b64` and restore local DB after confirmation.

## 10. Authentication and Session Semantics

1. Session key is process memory only.
2. Never persist decrypted user master key to disk.
3. On process exit, best-effort zeroization.
4. Commands that require decryption must fail with clear message if not logged in.

Optional future enhancement:

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
15. `BackupTargetNotConfigured`
16. `PathAmbiguous`

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
12. `regex` for rg-like path query matching (smart-case regex + literal fallback).
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
2. Resolve user-provided `<path>` via fuzzy matcher to one `path_hint`.
3. Load row by resolved `path_hint`.
4. Read `entry_key` and `value`.
5. Unwrap `doc_key` using user master key and `entry_key`.
6. Decrypt `value` into compressed history bytes.
7. Brotli decompress and parse JSON.
8. Reconstruct commits/snapshots.
9. Render latest snapshot.

### 15.3 `backup push`

1. Load and validate TOML config.
2. Open `db_path` and read SQLite file bytes.
3. Generate backup nonce/salt and derive backup encryption key from root master key.
4. Encrypt + authenticate backup payload.
5. Resolve upload targets from `--target <name>` or `--all`.
6. Upload encrypted object to each selected S3-compatible backend (R2/GCS/AWS S3).
7. Return per-target object key and checksum.

### 15.4 `backup pull --target <name>`

1. Load and validate TOML config.
2. Resolve selected target profile from `--target`.
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
8. Canonicalization and semantic equality rules for diffing.
9. Field-level hash stability and change detection.

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
5. Multi-target push (`--all`) and provider-selective pull (`--target r2|aws|gcs`) coverage.
6. Diff behavior on reorder/whitespace/normalization scenarios.

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

Goal:
1. Create a buildable, testable Rust CLI baseline with module boundaries.

Scope:
1. Workspace bootstrap, CLI command wiring, error type scaffolding, logging policy.

Exit criteria:
1. `secbits --help` shows full command surface.
2. Basic CI checks and test harness run successfully.

### 17.2 Milestone 2: Storage Layer and Migrations

Goal:
1. Establish stable local persistence for users and entries.

Scope:
1. SQLite connection lifecycle, schema creation, migration runner, repository layer.

Exit criteria:
1. Fresh DB bootstraps automatically.
2. CRUD storage tests pass for users and entries.

### 17.3 Milestone 3: Crypto and Compression Core

Goal:
1. Implement production-safe cryptographic and compression primitives.

Scope:
1. leancrypto wrappers, brotli wrappers, blob layout codec, zeroization hooks.

Exit criteria:
1. Encrypt/decrypt round-trip tests pass.
2. Tamper/auth-failure tests pass.

### 17.4 Milestone 4: Authentication Lifecycle

Goal:
1. Support secure root master key validation and user master key lifecycle.

Scope:
1. `init`, `login`, in-memory session semantics, auth-related error mapping.

Exit criteria:
1. Correct key setup/verification behavior validated by unit and integration tests.
2. Wrong root key reliably fails with explicit error.

### 17.5 Milestone 5: Entry History Engine

Goal:
1. Deliver robust entry storage with commit history semantics.

Scope:
1. `entry_key` wrapping, encrypted history payload, commit hash, dedup, restore, structured deltas.

Exit criteria:
1. History reconstruction and restore tests pass.
2. Dedup behavior verified across unchanged updates.

### 17.6 Milestone 6: Path UX and Core Commands

Goal:
1. Provide complete pass-style command workflows with fuzzy path resolution.

Scope:
1. `ls/show/insert/edit/rm/history/restore/logout`, path matcher, ambiguity handling.

Exit criteria:
1. Core workflow integration tests pass.
2. Path resolution behavior meets 9.2 design and implementation rules.

### 17.7 Milestone 7: Config and Backup Targets

Goal:
1. Enable deterministic TOML-driven runtime config and encrypted backups.

Scope:
1. Config load order/validation, backup push/pull, multi-target selection logic.

Exit criteria:
1. Backup round-trip tests pass for selected target and `--all`.
2. Disaster-recovery scenario passes.

### 17.8 Milestone 8: Diff Accuracy and Quality Hardening

Goal:
1. Improve diff precision and finalize operational quality.

Scope:
1. Canonicalization rules, semantic diff logic, field-level hashes, error-hardening.

Exit criteria:
1. Diff normalization and structured-delta tests pass.
2. No unresolved critical defects in security-sensitive paths.

### 17.9 Milestone 9: Release Readiness

Goal:
1. Ship a documented, reproducible CLI release.

Scope:
1. Packaging, operational docs, command examples, final verification matrix.

Exit criteria:
1. All quality gates in 16.6 pass.
2. Release artifact and documentation are complete.

## 18. Open Decisions (Track Explicitly)

### 18.1 Path Uniqueness Scope

Question:
1. Should `path_hint` uniqueness be global or per-user?

Current default:
1. Global uniqueness (`UNIQUE(path_hint)`).

Alternative:
1. Per-user uniqueness with `UNIQUE(user_id, path_hint)`.

### 18.2 TOTP Helper Command

Question:
1. Should TOTP generation be included in CLI output helpers?

Current default:
1. Keep model support only; add `totp <path>` command surface later if required.

### 18.3 Import and Export

Question:
1. Should JSON import/export be included?

Current default:
1. Keep as a future enhancement.

### 18.4 Backup Scheduling

Question:
1. Should backups be manual only or allow timer-based automation?

Current default:
1. Manual by default.

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

1. strict retention of existing enc/dec/auth behavior,
2. sqlite-backed local persistence,
3. pass-style path UX,
4. TOML-driven CLI configuration (root key, db path, backup targets),
5. multi-target encrypted backup support for R2/GCS/AWS S3 in one config,
6. and a detailed, testable implementation plan for starting from an empty repository state.
