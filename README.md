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
6. `app`: domain flows (init/insert/show/edit/history/restore).
7. `backup`: backup pack/unpack, S3-compatible upload/download flows.

### 4.1 CLI TOML Config

Config file format: TOML.

```toml
root_master_key_b64 = "BASE64_ROOT_MASTER_KEY"
db_path = "/home/user/.local/share/secbits/secbits.db"
username = "alice"
backup_on_save = false  # optional; when true, triggers backup push --all after every successful write command
log_level = "info"      # optional; one of: trace, debug, info, warn, error
log_target = false      # optional; include target/module name in log lines
log_time = false        # optional; include timestamp as [dd/mm/yyyy hh:mm:ss.sss]

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
3. `username` identifies the active user in the local database. Required for all commands that access entries.
4. `backup_on_save` is optional and defaults to `false`. When `true`, triggers `backup push --all` automatically after every successful write command (`insert`, `edit`, `restore`).
5. `log_level` is optional and defaults to `info`; valid values are `trace`, `debug`, `info`, `warn`, `error`.
6. `log_target` is optional and defaults to `false`; when `true`, logs include the module/target name.
7. `log_time` is optional and defaults to `false`; when `true`, logs include timestamps formatted as `[dd/mm/yyyy hh:mm:ss.sss]`.
8. `[targets.<name>]` defines one or more S3-compatible backup targets, allowing R2, AWS S3, and GCS to be configured at the same time.
9. `provider` identifies behavior differences (`r2`, `aws`, `gcs`) while still using S3 API-compatible upload/download flows.
10. Secrets in config must be protected by filesystem permissions (`0600`) or environment override strategy.

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
  path_hint TEXT NOT NULL,
  entry_key BLOB NOT NULL,
  value BLOB NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
  UNIQUE(user_id, path_hint)
);

CREATE INDEX idx_entries_user_id ON entries(user_id);
```

Migration 2 (sharing keypairs — applied when `PRAGMA user_version = 1`):

```sql
ALTER TABLE users ADD COLUMN share_public_key BLOB;      -- NULL until share-init
ALTER TABLE users ADD COLUMN share_secret_key_enc BLOB;  -- NULL until share-init
PRAGMA user_version = 2;
```

Notes:

1. `user_id` and `entry_id` are integer primary keys.
2. `path_hint` stores pass-style path (`mail/google/main`) and is unique per user.
3. `entry_key` stores wrapped per-entry doc key bytes.
4. `value` stores encrypted history blob bytes.
5. Secrets must never be written to plaintext columns.
6. Each schema change increments `PRAGMA user_version` and is implemented as a numbered migration in the migration runner.

## 6. Cryptographic Invariants (Must Match Existing Design)

Constants:

- `SALT_LEN = 64`
- `USER_MASTER_KEY_LEN = 64`
- `DOC_KEY_LEN = 64`
- `ENC_KEY_LEN = 64` (512-bit AEAD key)
- `ENC_IV_LEN = 64` (512-bit IV as required by the leancrypto Ascon-Keccak-512 API; verify against leancrypto header definitions before finalizing)
- `TAG_LEN = 64` (512-bit authentication tag)
- `HKDF_OUT_LEN = 128` (= `ENC_KEY_LEN + ENC_IV_LEN`)
- `MASTER_BLOB_LEN = 192` (= `SALT_LEN + USER_MASTER_KEY_LEN + TAG_LEN`)

Sharing constants (ML-KEM-1024 + X448 hybrid KEM; verify all sizes against leancrypto `lc_kyber_x448.h`):

- `SHARE_PK_LEN = 1624` (ML-KEM-1024 pk 1568 + X448 pk 56)
- `SHARE_SK_LEN = 3224` (ML-KEM-1024 sk 3168 + X448 sk 56)
- `SHARE_CT_LEN = 1624` (ML-KEM-1024 ct 1568 + X448 ephemeral pk 56)
- `SHARE_SS_LEN = 64` (hybrid shared secret output)

Algorithms:

1. HKDF with SHA3-512 via leancrypto.
2. AEAD Ascon-Keccak-512 via leancrypto using 512-bit key, 512-bit IV, and 512-bit tag. Ciphertext length equals plaintext length (stream cipher mode); authentication is provided by the separate 64-byte tag.
3. Brotli compression before encrypting entry history.
4. Blob layout: `salt || ciphertext || tag`.

### 6.1 Root Master Key Validation

Input root key is base64 text.

Validation rules:

1. Must decode successfully.
2. Decoded length must be `>= 256` bytes.
3. Else fail fast with explicit error.

Key generation guidance: generate at least 256 bytes of cryptographically random data and base64-encode it. Example: `openssl rand -base64 344 | tr -d '\n'` produces a 256-byte decoded key.

### 6.2 User Master Key Setup

1. Generate random `user_master_key` (64 bytes).
2. Generate random `salt` (64 bytes).
3. Derive `{encKey, encIv}` from `root_master_key + salt` using HKDF-SHA3-512.
4. AEAD-encrypt `user_master_key` using `{encKey, encIv}` with 64-byte tag.
5. Persist `user_master_key_blob = salt || encrypted_user_master_key || tag` (192 bytes).
6. Keep plaintext user master key in memory only for the current process invocation.

### 6.3 User Master Key Verify

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
   - `root_master_key_b64`, `db_path`, and `username` for all commands.
   - At least one `[targets.<name>]` section for backup commands.
   - `backup_on_save` must be a boolean if present; defaults to `false` if absent.
   - Logging fields are optional; `log_level` must be one of `trace|debug|info|warn|error`; `log_target` and `log_time` must be booleans if present.
5. Expand `~` in paths and normalize `db_path`.
6. Return explicit error (`ConfigFileNotFound` or `InvalidConfigField`) on failure.

Operational notes:

1. All commands read config at startup.
2. `backup pull --target <name>` and `backup push --target <name>` require that target to exist in `[targets.<name>]`.
3. `backup push --all` requires at least one configured target.

### 9.2 Path Resolution (Fuzzy Matching)

#### 9.2.1 Design and Goals

Path-oriented commands support fuzzy matching against `entries.path_hint`. All matching is scoped to the active user identified by `username` in config.

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
   - Exact check first: `SELECT path_hint FROM entries WHERE path_hint = ? AND user_id = ? LIMIT 2`.
   - If no exact match, fetch candidate set (`SELECT path_hint FROM entries WHERE user_id = ? ORDER BY path_hint`) or a prefix-filtered variant.
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

2. `secbits ls [prefix]`
   - List `path_hint` values for the active user, optionally filtered by prefix.

3. `secbits show <path>`
   - Resolve `<path>` with fuzzy matcher to one entry.
   - Unwrap `entry_key`, decrypt `value`, and read history.
   - Print latest snapshot.

4. `secbits insert <path>`
   - Reject if path format is invalid (`InvalidPathHint`) or path already exists for the active user (`PathAlreadyExists`).
   - Read secret fields from prompt/editor.
   - Create doc key, wrapped `entry_key`, and encrypted `value`.
   - If `backup_on_save = true`, trigger `backup push --all` on success.

5. `secbits edit <path>`
   - Resolve `<path>` with fuzzy matcher to one entry.
   - Decrypt latest snapshot.
   - Edit fields.
   - Append commit if changed.
   - If `backup_on_save = true`, trigger `backup push --all` on success.

6. `secbits rm <path>`
   - Resolve `<path>` with fuzzy matcher to one entry.
   - Delete by resolved `path_hint` after confirmation.

7. `secbits history <path>`
   - Resolve `<path>` with fuzzy matcher to one entry.
   - Print commits: hash, parent, timestamp, changed fields.

8. `secbits restore <path> --commit <hash>`
   - Resolve `<path>` with fuzzy matcher to one entry.
   - Apply restore flow and persist new history blob.
   - If `backup_on_save = true`, trigger `backup push --all` on success.

9. `secbits totp <path>`
   - Resolve `<path>` with fuzzy matcher to one entry.
   - Extract `totpSecrets` from the latest snapshot. Return `NoTotpSecrets` if empty.
   - Compute and display the current TOTP code(s) (RFC 6238, 30-second window, 6 digits) with seconds remaining in the current window.

10. `secbits export --output <file>`
    - Decrypt all entries for the active user.
    - Serialize one DB-shaped JSON object:
      - Top level: `username`, plaintext base64 `user_master_key`.
      - `entries[]`: each item has `path_hint`, plaintext base64 unwrapped `entry_key` (64-byte doc key), and `value` (full decrypted history object).
    - Write JSON to `<file>` only (`--output` is required).
    - Print a warning that the output is plaintext.

11. `secbits backup push [--target <name> | --all]`
    - One of `--target <name>` or `--all` must be provided; invoking with neither flag is an error.
    - Creates encrypted snapshot of local DB and uploads to one selected backup target or all configured targets.
    - Object key format per target: `<prefix><username>/<timestamp_utc_iso8601>.secbits.enc`.

12. `secbits backup pull --target <name> [--object <key>]`
    - Downloads latest (or specified) encrypted backup object from the selected backup target.
    - "Latest" is determined by listing objects under `<prefix><username>/` and selecting the lexicographically largest key (ISO-8601 timestamps sort correctly this way).
    - Verifies/decrypts using `root_master_key_b64` and restores local DB after confirmation.

13. `secbits share-init`
    - Generate hybrid ML-KEM-1024 + X448 keypair. Idempotent: prompts for confirmation before overwriting existing keys.
    - Store public key and encrypted secret key in the `users` row.

14. `secbits share-pubkey [--output <file>]`
    - Export own hybrid public key to `<file>` or stdout (raw bytes, `SHARE_PK_LEN` bytes).
    - Return `ShareKeysNotInitialized` if `share-init` has not been run.

15. `secbits share <path> --recipient-key <file> [--output <file> | --target <name>]`
    - Encrypt current entry snapshot for the recipient and write share payload to `<file>` or upload to S3 relay via `--target`.
    - See §20 for full protocol.

16. `secbits share-receive [--input <file> | --target <name> [--object <key>]] [--save-as <path>]`
    - Receive and decrypt a share payload; insert the shared snapshot as a new entry in the active user's vault.
    - See §20 for full protocol.

### 9.4 Interactive Entry Input Design

This section governs the UX for all interactive field collection used by `insert` and `edit`. The design was driven by a concrete audit of the initial implementation that exposed several security and usability gaps.

### 9.4.1 Field Security Classification

**Rationale:** treating all fields identically with a plain echoing prompt leaks secrets to anyone watching the screen, to terminal scrollback, and to screen recordings.

Fields are classified into three tiers:

1. **Secret fields — masked input, no echo:** `password`, each entry of `totpSecrets`. Uses the `rpassword` crate for terminal-safe masked reads. Nothing is displayed while the user types (no `*` substitution, which would leak length).
2. **Sensitive-free-text field — editor or multi-line masked:** `notes`. May contain recovery codes, API keys, and other secrets; a single-line echoing prompt is inadequate.
3. **Plain fields — normal echo:** `title`, `username`, `urls`, `tags`, `customFields`.

### 9.4.2 Password Confirmation

**Rationale:** a masked password field gives no visual feedback. A single typo stores the wrong value with no recovery path other than a manual `edit`.

**Solution:** after the initial masked `password` prompt, immediately re-prompt with `repeat password:`. If the two values differ, print `Passwords do not match.` and loop until they match or the user cancels. Return `PasswordConfirmationMismatch` if the loop is aborted programmatically (e.g. EOF on stdin).

### 9.4.3 TOTP Secret Validation at Entry Time

**Rationale:** an invalid TOTP secret is accepted silently during `insert` and only surfaces as a confusing error when `totp` is later invoked. At that point the user does not know which stored secret is broken.

**Solution:** after collecting each TOTP secret, immediately:

1. Attempt Base32 decode. On failure, print `Invalid TOTP secret: not valid Base32.` and re-prompt for that secret.
2. Enforce minimum length: decoded secret must be `>= 10` bytes (RFC 4226 HMAC key minimum). Warn (but do not reject) if `< 16` bytes: `Warning: TOTP secret is shorter than the recommended 16 bytes.`

Return `InvalidTotpSecret` if the user provides an invalid value in non-interactive (piped) mode.

### 9.4.4 Multi-value Field Input (URLs, Tags, TOTP Secrets)

**Rationale:** comma-separated input silently breaks when field values contain commas. A URL with a comma in a query parameter or a tag containing a comma is split into two invalid entries with no error. There is no escaping mechanism.

**Solution:** collect multi-value fields one entry per line, terminated by an empty line:

```
urls (one per line, empty line to finish):
  > https://mail.google.com
  > https://accounts.google.com
  >
```

The prompt indicator `>` is printed before each line. An empty line ends collection. This eliminates parsing ambiguity and allows any Unicode value in any field.

In non-interactive (piped) mode the JSON schema input is unchanged; this rule applies only to the interactive prompt path.

### 9.4.5 Notes Field — Multi-line and Editor-backed

**Rationale:** `notes` is routinely used for multi-line content (SSH config snippets, 2FA recovery codes, multi-line API credentials). A single `read_line` call silently discards all content after the first newline when input is piped, causing data loss with no error.

**Solution:**

1. If `$VISUAL` or `$EDITOR` is set, write an empty temporary file to `$XDG_RUNTIME_DIR` if available (typically a `tmpfs` mount), otherwise fall back to the system temp dir. Launch the editor process and wait for it to exit. Read back the file contents. Securely overwrite the temp file with zeros before deletion (best-effort).
2. If no editor is configured and stdin is a terminal, collect multi-line input terminated by `Ctrl+D` (EOF): prompt header is `notes (Ctrl+D to finish, or leave blank):`.
3. If stdin is not a terminal (piped mode), read until EOF for the notes value.

Security note on temp file: create with mode `0600`, in a directory not world-readable. Do not use a predictable filename. Zeroize contents before unlinking.

### 9.4.6 Custom Fields Interactive Support

**Rationale:** `customFields` is a first-class part of the entry model (shown in `show` output, tracked in history deltas) but the initial interactive prompt path had no mechanism to create them. Custom fields were therefore unreachable for interactive users.

**Solution:** after all fixed fields are collected, offer a creation loop:

```
custom field label (empty to finish): API token
custom field value: sk-...
custom field label (empty to finish):
```

Field IDs are assigned as monotonically increasing integers starting from 1. If the label text suggests a sensitive value (contains `key`, `secret`, `token`, `password`, `credential`, or `api` case-insensitively), the value prompt automatically switches to masked input and the user is notified: `(masked — label suggests sensitive value)`.

### 9.4.7 Optional Field Skipping

**Rationale:** most entries only need `title`, `username`, and `password`. Unconditionally presenting all seven field groups forces the user through four extra Enter presses for fields they do not want.

**Solution:** present fields in two stages.

Stage 1 — always prompted (core fields):

1. `title`
2. `username`
3. `password` (masked, with confirmation)

Stage 2 — each preceded by a yes/no gate:

4. `Add URLs? [y/N]`
5. `Add notes? [y/N]`
6. `Add TOTP secrets? [y/N]`
7. `Add tags? [y/N]`
8. `Add custom fields? [y/N]`

Answering `N` (or pressing Enter) skips that group; the field is stored as its empty default. This allows a three-prompt insert path for the common case while keeping full fields accessible.

### 9.4.8 Abort Mechanism and Terminal Safety

**Rationale:** there is no documented cancel path. If the user decides mid-entry that they entered the wrong path or want to start over, only `Ctrl-C` works and it leaves no clear indication that nothing was written. After a masked read, a kill signal can leave the terminal with echo disabled if cleanup is not handled.

**Solution:**

1. Print `(Ctrl-C to cancel)` in the preamble line before any prompts begin.
2. The `rpassword` crate restores terminal echo on drop, covering both normal exit and signal receipt; verify this in integration tests.
3. On `SIGINT` received during field collection, print a newline followed by `Aborted.` to stdout and exit with code 130. No data is written to the database if the user cancels at any point before the final write.

### 9.4.9 Command-invocation Log Demotion for Interactive Commands

**Rationale:** the INFO `command invoked` log line fires before interactive prompts begin, injecting a timestamp banner that disrupts the visual flow of the session. This log is most useful for audit trails in automated/scripted contexts where a higher log level is typical.

**Solution:** demote the command-invocation log from `INFO` to `DEBUG` for commands that collect interactive input (`insert`, `edit`). The log continues to fire at INFO level for all non-interactive commands. With the default `log_level = info` a user running an interactive session sees a clean prompt with no preceding banner.

### 9.4.10 Post-Insert Summary

**Rationale:** after completing entry, the only output is a logging line confirming the path. The user has no visible confirmation of which fields were stored with non-empty values and must run `show` to verify.

**Solution:** after a successful `insert` (or `edit` that records a change), print a compact non-secret summary to stdout:

```
Inserted test/email/1
  title:    Gmail
  username: alice@example.com
  urls:     2
  totp:     1 secret
  tags:     work
```

Rules:
1. `password` value is never printed. Show only `password: set` vs `password: (empty)`.
2. `notes` value is never printed. Show only `notes: set (N bytes)` vs `notes: (empty)`.
3. TOTP secret values are never printed. Show count only.
4. `customFields` values are never printed. Show `custom fields: N`.
5. Fields absent or empty are omitted from the summary entirely.

## 10. Authentication and Session Semantics

The CLI is stateless across invocations. Each process invocation reads the root master key from config, performs its work, and zeroizes all key material before exit.

1. The root master key is read from the TOML config on every command startup.
2. Every command that requires decryption automatically verifies the root master key against the stored user master key blob before proceeding. If verification fails, the command returns `WrongRootMasterKey`.
3. The decrypted user master key is held only in process memory for the duration of the command invocation.
4. On process exit, best-effort zeroization of all in-memory sensitive buffers.
5. Never persist the decrypted user master key to disk.
6. Commands that require decryption must fail with a clear message if no user record exists for the configured username (`UserNotFound`).

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
21. `NoTotpSecrets`
22. `ExportFailed`
23. `ShareKeysNotInitialized`
24. `InvalidRecipientPublicKey`
25. `InvalidSharePayload`
26. `ShareNotForThisUser`
27. `ShareDecryptFailed`
28. `ShareUploadFailed`
29. `ShareDownloadFailed`
30. `PasswordConfirmationMismatch`
31. `InvalidTotpSecret`

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
14. TOTP crate (e.g., `totp-rs` or `totp-lite`) for RFC 6238 TOTP code generation.
15. `rpassword` for masked terminal input of `password` and `totpSecrets` fields (see §9.4.1). Must restore terminal echo on drop and on signal receipt.

Note: the hybrid ML-KEM-1024 + X448 KEM functions (`lc_kyber_x448_1024_*`) are part of leancrypto and are covered by the existing FFI binding crate in item 9. No additional crate is required for sharing.

## 14. FFI Integration Strategy

### 14.1 Leancrypto

Implement a safe wrapper layer that exposes:

1. `hkdf_sha3_512(ikm, salt) -> (enc_key[64], enc_iv[64])`
2. `aead_encrypt(enc_key, enc_iv, plaintext) -> (ciphertext, tag[64])`
3. `aead_decrypt(enc_key, enc_iv, ciphertext, tag) -> plaintext | auth error`

Ascon-Keccak invocation requirements:
1. Set AEAD key length to 64 bytes (512 bits).
2. Set AEAD IV length to 64 bytes (512 bits).
3. Set AEAD tag length to 64 bytes (512 bits).
4. Use leancrypto AEAD one-shot encrypt/decrypt calls or equivalent init/update/final sequence with identical semantics.

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
4. Collect entry fields via interactive input (§9.4) or by reading JSON from stdin (non-interactive mode):
   - In interactive mode: follow §9.4.7 field ordering, §9.4.2 password confirmation, §9.4.3 TOTP validation, §9.4.4 multi-value line input, §9.4.5 notes editor/multi-line, §9.4.6 custom fields loop.
   - In non-interactive (piped) mode: read and parse a JSON object from stdin. Validate each `totpSecrets` entry for Base32 decodability; return `InvalidTotpSecret` on failure.
   - Return `PasswordConfirmationMismatch` if password and its confirmation differ (interactive mode).
5. Set `timestamp` to current UTC ISO-8601.
6. Generate `doc_key` (64 random bytes).
7. Build initial commit:
   - `parent = null`.
   - `timestamp` = current UTC ISO-8601 timestamp.
   - `changed` = list of all non-empty fields in the initial snapshot.
   - `hash` = content hash of the initial snapshot (per §8.1).
   - `delta.set` = all initially populated field values (serves as the reconstruction baseline per §8.3 rule 3).
   - `delta.unset` = all fields absent or empty in the initial snapshot.
8. Build compact history object: `{ "head": <hash>, "head_snapshot": <snapshot>, "commits": [<initial_commit>] }`.
9. Serialize history JSON.
10. Brotli compress serialized JSON.
11. Encrypt compressed history with `doc_key` via `encryptBytesToBlob` => `value` blob.
12. Wrap `doc_key` with user master key via `encryptBytesToBlob` => `entry_key` blob.
13. Write row with `entry_key = entry_key_blob` and `value = value_blob`.
14. Print post-insert summary per §9.4.10 (non-secret fields only).
15. If `backup_on_save = true` in config, trigger `backup push --all`.

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
13. If `backup_on_save = true` in config, trigger `backup push --all`.

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
11. If `backup_on_save = true` in config, trigger `backup push --all`.

### 15.8 `rm`

1. Verify root master key from config (confirms the user is authorized).
2. Resolve `<path>` via fuzzy matcher to one `path_hint`.
3. Print resolved `path_hint` and prompt for confirmation: "Delete `<path_hint>`? [y/N]".
4. On confirmation, delete the row by resolved `path_hint`. The `ON DELETE CASCADE` constraint removes all associated columns.
5. Print deletion confirmation.

### 15.9 `totp`

1. Verify root master key from config; derive user master key.
2. Resolve `<path>` via fuzzy matcher to one `path_hint`.
3. Load row; unwrap `doc_key`; decrypt and decompress history.
4. Extract `totpSecrets` from `head_snapshot`. Return `NoTotpSecrets` if the list is empty.
5. For each secret, compute the current TOTP code (RFC 6238, SHA-1, 30-second window, 6 digits).
6. Print each code with the seconds remaining in the current window.

### 15.10 `export`

1. Verify root master key from config; derive user master key.
2. Fetch all entry rows for the active user ordered by `path_hint`.
3. Build one JSON object with top-level user fields from `users`:
   `{ "username": "<username>", "user_master_key": "<base64>", "entries": [...] }`.
4. For each `entries` row: unwrap `doc_key`; decrypt and decompress `value` to the full history object.
5. Append one item to `entries`:
   `{ "path_hint": "<path_hint>", "entry_key": "<base64>", "value": <full history object> }`.
   Here, `entry_key` is the unwrapped 64-byte per-entry key (doc key), not the wrapped DB blob.
6. Write JSON to `--output <file>` only. Return `ExportFailed` on I/O error.
7. Print a warning that the output file contains plaintext secrets and should be handled accordingly.

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
15. TOTP code generation: known-secret/known-time produces expected 6-digit code.
16. `path_hint` uniqueness is per-user: two users can each have the same path without conflict; the same user cannot have duplicates.
17. Hybrid KEM round-trip: encapsulate with a known public key, decapsulate with the matching secret key, verify shared secret matches.
18. Share payload encode/decode round-trip produces byte-identical output for fixed inputs.

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
13. Any command run for a username not found in the database returns `UserNotFound`.
14. `totp` on an entry with no `totpSecrets` returns `NoTotpSecrets`.
15. `export --output <unwritable_path>` returns `ExportFailed`.
16. `share-pubkey` before `share-init` returns `ShareKeysNotInitialized`.
17. `share-receive` with a payload addressed to a different user returns `ShareNotForThisUser`.
18. `share-receive` with a tampered KEM ciphertext returns `ShareDecryptFailed`.
19. `share-receive` with a truncated payload returns `InvalidSharePayload`.
20. Recipient public key file of wrong length returns `InvalidRecipientPublicKey`.

### 16.3 Integration Tests

1. `init -> insert -> show -> edit -> history -> restore`.
2. Multi-entry pass-style path listing.
3. DB persistence across process restarts.
4. `backup push -> delete local db copy -> backup pull` disaster-recovery path.
5. Multi-target push (`--all`) and provider-selective pull (`--target r2|aws|gcs`) coverage.
6. Diff behavior on reorder/whitespace/normalization scenarios.
7. Commit overflow: apply 11 distinct edits to one entry; verify history length is exactly 10 and oldest commit's `delta.set` reflects its full snapshot.
8. `backup pull` overwrites local DB; verify the confirmation prompt and that cancellation leaves the existing DB intact.
9. `totp` on an entry with multiple `totpSecrets` displays all codes.
10. `export` produces a valid DB-shaped JSON object with top-level `username`, `user_master_key`, and `entries` for the active user only.
11. `export` without `--output <file>` fails CLI argument validation.
12. `backup_on_save = true`: `insert` automatically triggers a backup push on success.
13. Full share round-trip: Alice runs `share-init`, exports pubkey; Bob runs `share-init`, exports pubkey; Alice shares an entry with Bob via file; Bob receives and the decrypted snapshot matches Alice's original entry.
14. S3 relay share round-trip: Alice uploads share payload via `--target`; Bob pulls and imports it.

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

**Scope:** `init`, per-invocation session semantics, auth-related error mapping.

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

**Goal:** Provide complete pass-style command workflows with fuzzy path resolution and a secure, usable interactive entry input experience.

**Scope:** `ls/show/insert/edit/rm/history/restore/totp/export`, path matcher, ambiguity handling, `path_hint` format validation, per-user path scoping, interactive input design per §9.4.

**Exit criteria:**
1. Core workflow integration tests pass.
2. Path resolution behavior meets §9.2 design and implementation rules.
3. `InvalidPathHint` validation enforced on `insert`.
4. Per-user path uniqueness enforced: same `path_hint` allowed across different users, rejected for the same user.
5. `totp` computes correct codes against known-secret/known-time test vectors.
6. `export` produces a valid DB-shaped JSON object containing all and only the active user's entries.
7. `password` and `totpSecrets` fields use masked input (no echo) in interactive mode.
8. `password` requires confirmation in interactive mode; mismatch returns `PasswordConfirmationMismatch`.
9. Each TOTP secret is validated for Base32 decodability and minimum length at input time; `InvalidTotpSecret` returned on failure.
10. Multi-value fields (`urls`, `tags`, `totpSecrets`) collected one-per-line in interactive mode.
11. `notes` supports multi-line input (editor-backed when `$VISUAL`/`$EDITOR` is set, otherwise Ctrl+D-terminated).
12. `customFields` are reachable via interactive prompt loop.
13. Optional field groups are gated behind a yes/no prompt; core fields (title, username, password) are always collected.
14. Post-insert/post-edit summary printed to stdout (non-secret fields only, per §9.4.10).
15. `insert` and `edit` command-invocation log demoted to DEBUG; no INFO banner interrupts interactive prompts.
16. Ctrl-C cancels cleanly with `Aborted.` output and no database write; terminal echo is restored.

### 17.7 Milestone 7: Interactive Entry Input UX

**Goal:** Finalize the interactive entry-input flow defined in §9.4 as a first-class milestone.

**Scope:** Masked input, password confirmation, multi-value collection, multi-line notes, custom field loop, optional-field gating, and post-write summary behavior.

**Exit criteria:**
1. All §9.4 interactive behaviors are covered by integration tests.
2. Interactive prompts avoid leaking secrets to logs/stdout.
3. Cancel/error paths leave terminal state and database contents consistent.

### 17.8 Milestone 8: Config and Backup Targets

**Goal:** Enable deterministic TOML-driven runtime config and encrypted backups.

**Scope:** Config load order/validation, `username` and `backup_on_save` config fields, backup push/pull with key derivation per §15.3, safe replace flow per §15.4, multi-target selection logic, `backup_on_save` auto-trigger in write commands.

**Exit criteria:**
1. Backup round-trip tests pass for selected target and `--all`.
2. Disaster-recovery scenario passes.
3. `backup pull` safe replace is atomic; partial failure leaves existing DB intact.
4. `backup_on_save = true` triggers backup after `insert`, `edit`, and `restore`.

### 17.9 Milestone 9: Diff Accuracy and Quality Hardening

**Goal:** Improve diff precision and finalize operational quality.

**Scope:** Canonicalization rules, semantic diff logic, field-level hashes, error-hardening.

**Exit criteria:**
1. Diff normalization and structured-delta tests pass.
2. No unresolved critical defects in security-sensitive paths.

### 17.10 Milestone 10: Entry Sharing

**Goal:** Enable post-quantum-safe encrypted entry sharing between users.

**Scope:** Hybrid ML-KEM-1024 + X448 FFI wrappers, schema migration 2, `share-init`, `share-pubkey`, `share`, `share-receive` commands, share payload codec, S3 relay upload/download.

**Exit criteria:**
1. Hybrid KEM keypair generation, encapsulation, and decapsulation tests pass.
2. Full share round-trip (file-based) passes: sender and recipient vault snapshots match.
3. S3 relay share round-trip passes.
4. All share negative tests pass (tampered ciphertext, wrong recipient, malformed payload).

### 17.11 Milestone 11: Release Readiness

**Goal:** Ship a documented, reproducible CLI release.

**Scope:** Packaging, operational docs, command examples, final verification matrix.

**Exit criteria:**
1. All quality gates in §16.6 pass.
2. Release artifact and documentation are complete.

## 18. Minimal Acceptance Criteria

1. Can create user and verify root master key offline.
2. Can insert/show/edit/remove entries by pass-style path.
3. Entry data at rest is encrypted and authenticated.
4. History supports dedup, listing, and restore.
5. All crypto invariants match this document.
6. Can push encrypted backups to one or all configured backup targets.
7. Can pull encrypted backups from a chosen backup target.
8. `totp <path>` computes live TOTP codes from stored secrets.
9. `export` produces a plaintext DB-shaped JSON object containing top-level `username` + `user_master_key`, and per-entry unwrapped `entry_key` with full history in `value`.
10. `backup_on_save = true` in config triggers automatic backup after every write.
11. Can share an entry snapshot with another user using hybrid ML-KEM-1024 + X448.
12. Shared entry is decryptable only by the intended recipient; tampered payloads are rejected.

## 19. Summary

This design defines a Rust-native offline SecBits with:

1. Strict retention of existing enc/dec/auth behavior.
2. SQLite-backed local persistence with version-tracked schema migrations.
3. Pass-style path UX with fuzzy matching and per-user entry scoping.
4. TOML-driven CLI configuration (root key, username, db path, backup targets, backup_on_save).
5. Multi-target encrypted backup support for R2/GCS/AWS S3 with optional per-save auto-backup.
6. TOTP code generation and JSON export built into the CLI.
7. Post-quantum-safe entry sharing via hybrid ML-KEM-1024 + X448, with file and S3 relay transfer modes.
8. A detailed, testable implementation plan for starting from an empty repository state.

## 20. Entry Sharing Design

### 20.1 Overview and Goals

Entry sharing allows one SecBits user to deliver an encrypted copy of an entry's current snapshot to another user. The recipient imports it into their own vault as a new independent entry with a fresh commit history.

Design goals:

1. Post-quantum safety: ML-KEM-1024 provides security against quantum adversaries; X448 provides classical security. Both must be broken simultaneously to compromise a share.
2. Forward secrecy per share: ephemeral X448 scalar is generated fresh for every `share` invocation. Compromise of a recipient's long-term X448 key does not expose past shares.
3. No server required: share payloads are self-contained encrypted binary files. Any channel (filesystem copy, email, S3 relay, QR code) is sufficient.
4. No history leakage: only the current `head_snapshot` is shared. The recipient gets no visibility into the sender's commit history.
5. Recipient-bound: the payload is cryptographically bound to the recipient's public key. No other party can decrypt it, and the recipient can verify the binding fails if the payload is modified.
6. Private keys at rest are encrypted with the user's master key using the same `encryptBytesToBlob` helper as all other secret material.

### 20.2 Cryptographic Protocol

Uses leancrypto's native hybrid KEM: `lc_kyber_x448_1024`, which combines ML-KEM-1024 and X448 into a single encapsulation/decapsulation API.

**Encapsulation (sender side):**

1. Load recipient hybrid public key `recipient_pk` (`SHARE_PK_LEN` bytes).
2. Call `lc_kyber_x448_1024_enc(recipient_pk)`:
   - Internally: encapsulate under ML-KEM-1024 pk → `(mlkem_ct, ss_mlkem)`.
   - Internally: generate ephemeral X448 scalar, compute `ss_x448 = X448(eph_scalar, recipient_x448_pk)`, output `eph_pub` as X448 component.
   - Combine: `ss = KDF(ss_mlkem || ss_x448)` internally within leancrypto.
   - Output: `kem_ct` (`SHARE_CT_LEN` bytes) = `mlkem_ct || eph_pub`, `ss` (`SHARE_SS_LEN` bytes).
3. Derive wrap key: `(wrap_enc_key[64], wrap_enc_iv[64]) = hkdf_sha3_512(ikm=ss, salt=kem_ct[0..64])`.
4. Encrypt `doc_key` directly (no extra salt; wrap key is already ephemeral):
   - `(enc_key_ct, enc_key_tag) = aead_encrypt(wrap_enc_key, wrap_enc_iv, doc_key)`
   - `enc_doc_key = enc_key_ct || enc_key_tag` (`DOC_KEY_LEN + TAG_LEN = 128` bytes).
5. Encrypt snapshot with `doc_key` via `encryptBytesToBlob(doc_key, brotli(JSON(head_snapshot)))` → `enc_snapshot`.
6. Assemble share payload (§20.4).

**Decapsulation (recipient side):**

1. Load own hybrid secret key `own_sk` (decrypted from DB with user master key).
2. Parse `kem_ct` from payload.
3. Call `lc_kyber_x448_1024_dec(kem_ct, own_sk)` → `ss`.
4. Re-derive wrap key: `(wrap_enc_key, wrap_enc_iv) = hkdf_sha3_512(ikm=ss, salt=kem_ct[0..64])`.
5. Decrypt: `doc_key = aead_decrypt(wrap_enc_key, wrap_enc_iv, enc_key_ct, enc_key_tag)`. Return `ShareDecryptFailed` on auth failure.
6. Decrypt snapshot: `decryptBytesFromBlob(doc_key, enc_snapshot)` → brotli decompress → JSON parse.

### 20.3 Leancrypto API Wrappers

Add to the `crypto` module (§14.1 wrapper responsibilities apply):

1. `hybrid_kem_keypair() -> (pk[SHARE_PK_LEN], sk[SHARE_SK_LEN])`
2. `hybrid_kem_enc(recipient_pk: &[u8; SHARE_PK_LEN]) -> (ct[SHARE_CT_LEN], ss[SHARE_SS_LEN])`
3. `hybrid_kem_dec(ct: &[u8; SHARE_CT_LEN], own_sk: &[u8; SHARE_SK_LEN]) -> ss[SHARE_SS_LEN] | ShareDecryptFailed`

### 20.4 Share Payload Binary Format

All multi-byte integers are big-endian. The file extension is `.sbsh`.

```
Offset   Size      Field
------   --------  -----
0        4         Magic: 0x53425348 ("SBSH")
4        4         Version: 0x00000001
8        2         sender_username_len (uint16)
10       N         sender_username (UTF-8)
10+N     2         recipient_username_len (uint16)
12+N     M         recipient_username (UTF-8)
12+N+M   2         path_hint_len (uint16, suggested path for recipient's vault)
14+N+M   P         path_hint (UTF-8)
14+N+M+P SHARE_CT_LEN (1624)  kem_ciphertext
...      128       enc_doc_key (enc_key_ct[64] || enc_key_tag[64])
...      4         enc_snapshot_len (uint32)
...      enc_snapshot_len  enc_snapshot (salt[64] || ciphertext || tag[64])
```

Parsing rules:

1. Verify magic `0x53425348` and version `0x00000001`; return `InvalidSharePayload` on mismatch.
2. Validate all length-prefixed fields are within their maximum allowed sizes (usernames ≤ 255 bytes, path_hint ≤ 512 bytes).
3. Verify `recipient_username` matches the active user's `username`; return `ShareNotForThisUser` if not.
4. Any truncation or overrun returns `InvalidSharePayload`.

### 20.5 Key Storage

`share_public_key` (plain): raw `SHARE_PK_LEN` bytes stored directly — public keys are not secret.

`share_secret_key_enc`: `encryptBytesToBlob(user_master_key, hybrid_sk)` — same protection as `entry_key`. Blob size = `SALT_LEN + SHARE_SK_LEN + TAG_LEN = 64 + 3224 + 64 = 3352` bytes.

Both columns are NULL until `share-init` is run. Commands that require sharing keys check for NULL and return `ShareKeysNotInitialized`.

### 20.6 Transfer Mechanisms

**File-based (primary — fully offline):**

Alice writes the payload to a local file; Bob receives the file through any channel.

```
alice$ secbits share mail/google/main \
         --recipient-key bob.key \
         --output share_mail_google.sbsh

# Alice sends share_mail_google.sbsh to Bob via any channel.

bob$   secbits share-receive \
         --input share_mail_google.sbsh \
         --save-as mail/google/from-alice
```

**S3 relay (optional — uses existing backup targets):**

Alice uploads the payload to a configured target; Bob pulls it down. The object is encrypted, so storage-side visibility provides no cryptographic advantage to an attacker.

Object key format: `<prefix>shares/<recipient_username>/<timestamp_utc_iso8601>.sbsh`

"Latest" share object for a recipient: lexicographically largest key under `<prefix>shares/<recipient_username>/` (same rule as backup pull).

```
alice$ secbits share mail/google/main \
         --recipient-key bob.key \
         --target r2

bob$   secbits share-receive \
         --target r2 \
         --save-as mail/google/from-alice
```

### 20.7 Detailed Command Flows

**`share-init`:**

1. Verify root master key; derive user master key.
2. If `share_public_key` is non-NULL in the user row, prompt: "Sharing keys already exist. Regenerate? [y/N]". Exit on no.
3. Call `hybrid_kem_keypair()` → `(pk, sk)`.
4. Encrypt: `share_secret_key_enc = encryptBytesToBlob(user_master_key, sk)`.
5. Update user row: `share_public_key = pk`, `share_secret_key_enc = encrypted_sk`.
6. Zeroize `sk`.
7. Print confirmation with public key length.

**`share-pubkey [--output <file>]`:**

1. Verify root master key; load user row.
2. Return `ShareKeysNotInitialized` if `share_public_key` IS NULL.
3. Write raw `share_public_key` bytes to `--output <file>` or stdout.

**`share <path> --recipient-key <file> [--output <file> | --target <name>]`:**

1. Verify root master key; derive user master key.
2. Resolve `<path>` via fuzzy matcher to one `path_hint`.
3. Load row; unwrap `doc_key`; decrypt and decompress history; extract `head_snapshot`.
4. Read recipient public key file. Validate size = `SHARE_PK_LEN`; return `InvalidRecipientPublicKey` on mismatch.
5. Encapsulate: `(kem_ct, ss) = hybrid_kem_enc(recipient_pk)`.
6. Derive: `(wrap_enc_key, wrap_enc_iv) = hkdf_sha3_512(ikm=ss, salt=kem_ct[0..64])`.
7. Encrypt: `(enc_key_ct, enc_key_tag) = aead_encrypt(wrap_enc_key, wrap_enc_iv, doc_key)`.
8. Compress and encrypt snapshot: `enc_snapshot = encryptBytesToBlob(doc_key, brotli(JSON(head_snapshot)))`.
9. Assemble share payload per §20.4 (using `path_hint` as the suggested recipient path).
10. Write to `--output <file>` or upload to `<prefix>shares/<recipient_username>/<timestamp>.sbsh` via `--target <name>`.
11. Zeroize `ss`, `wrap_enc_key`, `wrap_enc_iv`, `doc_key`.
12. Print confirmation with payload size and destination.

**`share-receive [--input <file> | --target <name> [--object <key>]] [--save-as <path>]`:**

1. Verify root master key; derive user master key.
2. Load share payload:
   - `--input <file>`: read from local file.
   - `--target <name>`: list objects under `<prefix>shares/<active_username>/`, select lexicographically largest (or explicit `--object`), download.
3. Parse payload header (§20.4 rules). Return `InvalidSharePayload` on parse failure.
4. Verify `recipient_username` matches active user's `username`. Return `ShareNotForThisUser` if not.
5. Load and decrypt share secret key: `sk = decryptBytesFromBlob(user_master_key, share_secret_key_enc)`.
6. Decapsulate: `ss = hybrid_kem_dec(kem_ct, sk)`. Return `ShareDecryptFailed` on failure.
7. Re-derive: `(wrap_enc_key, wrap_enc_iv) = hkdf_sha3_512(ikm=ss, salt=kem_ct[0..64])`.
8. Decrypt: `doc_key = aead_decrypt(wrap_enc_key, wrap_enc_iv, enc_key_ct, enc_key_tag)`. Return `ShareDecryptFailed` on auth failure.
9. Decrypt and decompress snapshot: `decryptBytesFromBlob(doc_key, enc_snapshot)` → brotli decompress → JSON parse.
10. Determine target `path_hint` for the new entry:
    - Use `--save-as <path>` if provided.
    - Otherwise use the `path_hint` from the payload header as default suggestion; prompt if a conflict exists for the active user.
11. Insert the received snapshot as a new entry (§15.1 flow from step 4 onward), treating the snapshot as the initial state.
12. Zeroize `ss`, `wrap_enc_key`, `wrap_enc_iv`, `doc_key`, `sk`.
13. Print confirmation: sender username, suggested path, saved path.

### 20.8 Security Properties

1. **Post-quantum confidentiality**: Breaking confidentiality requires breaking both ML-KEM-1024 (NIST PQC) and X448 simultaneously.
2. **Classical forward secrecy per share**: a fresh X448 ephemeral scalar is generated inside `lc_kyber_x448_1024_enc` for each call. Long-term X448 key compromise does not expose past share payloads.
3. **Ciphertext binding**: the wrap key is derived with `salt=kem_ct[0..64]`. Substituting a different ciphertext changes the derived wrap key, causing AEAD authentication of `enc_doc_key` to fail.
4. **Recipient binding**: the `recipient_username` in the payload is checked before decapsulation. A misdirected payload is rejected before any crypto is attempted.
5. **No plaintext leakage to relay**: when using S3, only encrypted payloads are uploaded. The relay server learns the recipient username (from the object key path) and payload size only.
6. **No history exposure**: only `head_snapshot` is included. The sender's commit history, prior passwords, and doc_key are not present in the payload.
