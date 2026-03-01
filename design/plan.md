# Implementation Plan

Seven milestones, each with a working and testable deliverable. Later milestones build on
earlier ones; no milestone leaves the codebase in a broken state.

---

## M1: Project Scaffold and Cryptography Layer

**Goal:** Tauri 2 project builds and runs. The crypto and compression primitives are
implemented, tested, and isolated from the rest of the app.

**Deliverables**

- Tauri 2 project init: `package.json`, `vite.config.js`, `index.html`, `backend/Cargo.toml`,
  `backend/tauri.conf.json`, `backend/src/main.rs` (empty app builder).
- `backend/src/error.rs`: `AppError` enum with all variants; `thiserror` derive; Tauri
  serialization to `{ "type": "VariantName", "message"?: "..." }`.
- `backend/src/crypto.rs`: leancrypto FFI init (`lc_init`), HKDF-SHA3-512 wrapper,
  Ascon-Keccak-512 AEAD wrapper, `encrypt_bytes_to_blob`, `decrypt_bytes_from_blob`.
  All blob format constants (`MAGIC_LEN`, `VERSION_LEN`, `SALT_LEN`, `TAG_LEN`, etc.).
- `backend/src/compression.rs`: Brotli `compress` and `decompress` wrappers.
- Rust unit tests: blob round-trips, tamper detection (magic, salt, ciphertext, tag),
  truncated blob rejection, HKDF determinism, compression round-trip.

**Acceptance**

- `cd backend && cargo test` passes all tests.
- `cargo tauri dev` opens a blank Tauri window (no crash, no error).

---

## M2: Database, Config, and Session

**Goal:** The backend can initialize a vault, unlock it (decrypt the user master key),
and lock it. No entry operations yet.

**Deliverables**

- `backend/src/config.rs`: parse TOML config; validate `root_master_key` (base64, min 256
  bytes decoded); load `db_path`, `backup_on_save`, backup targets.
- `backend/src/db.rs`: `create_schema` creating all four tables (`vault_info`, `key_store`,
  `entries`, `trash`) with correct columns and constraints; `PRAGMA foreign_keys = ON`.
  Minimal query functions: vault_info get/set, key_store UMK get/set.
- `backend/src/model.rs`: `EntrySnapshot` and `HistoryObject` struct definitions only
  (no business logic yet); `serde` derives.
- `backend/src/state.rs`: `AppState` with `Mutex<Connection>`, optional session key bytes
  (zeroed on lock via `zeroize`), and config.
- `backend/src/app.rs`: `init_vault`, `is_initialized`, `unlock_vault`, `lock_vault`.
- `backend/src/commands.rs`: register the four session commands.
- Rust unit tests: config parsing edge cases, schema creation, session lifecycle
  (init, unlock correct key, unlock wrong key, lock, re-unlock).

**Acceptance**

- `cargo test` passes.
- Running the app, supplying a valid config, and calling `unlock_vault` from a browser
  console test (or minimal React placeholder) succeeds; calling with wrong key returns
  the structured `WrongRootMasterKey` error.

---

## M3: Entry CRUD and History Engine

**Goal:** Entries can be created, read, updated, and deleted. The full history model
(commits, deltas, dedup, overflow) is implemented and tested.

**Deliverables**

- `backend/src/model.rs`: full business logic.
  - `content_hash`: SHA-256 over snapshot JSON excluding `timestamp`; first 32 hex chars.
  - `normalize_for_compare`: tags (case-insensitive set), URLs (lowercase + strip trailing
    slash, set), `totpSecrets` (set), `customFields` (by id), all others exact.
  - `append_snapshot`: dedup check, prepend commit, assign delta to prior HEAD commit,
    overflow handling (drop oldest, rebuild full-snapshot delta at new oldest).
  - `reconstruct_snapshot`: backward delta application from `head_snapshot` to any commit.
  - `restore_to_commit`: reconstruct + append_snapshot (with dedup).
- `backend/src/db.rs`: full entry CRUD queries, trash queries, key_store queries for
  per-entry doc key wrapping.
- `backend/src/app.rs`: `create_entry`, `get_entry`, `update_entry`, `delete_entry`,
  `list_entries` (with search/tag filter), `list_trash`, `get_trash_entry`,
  `restore_entry`, `purge_entry`.
- `backend/src/commands.rs`: all entry and trash commands registered.
- Rust unit tests: all `model.rs` cases (content_hash, dedup, single/multi-commit delta,
  overflow, reconstruct, restore_to_commit, normalize_for_compare), all CRUD command
  cases, trash lifecycle.

**Acceptance**

- `cargo test` passes.
- Full entry CRUD lifecycle works end-to-end from a minimal test harness or placeholder UI.

---

## M4: History Commands, TOTP, Export, and Settings

**Goal:** All remaining backend commands are implemented. The backend is feature-complete.

**Deliverables**

- `backend/src/app.rs`:
  - `get_history`: return commit list (hash, parent, timestamp, changed) without delta values.
  - `get_commit_snapshot`: call `reconstruct_snapshot`; return full snapshot at given hash.
  - `restore_to_commit`: already in model.rs; wire command.
  - `get_totp`: HMAC-SHA1 RFC 6238, 30-second step, 6-digit output; multiple secrets.
  - `export_vault`: decrypt all active + trash entries; serialize to canonical JSON format.
  - `rotate_master_key`: validate new key length; re-encrypt UMK blob; persist.
  - `get_vault_stats`: count entries by type (requires decrypting each entry's history to
    read type), commit totals, top tags.
- `backend/src/commands.rs`: history, TOTP, export, and settings commands registered.
- Rust unit tests: RFC 6238 test vectors for TOTP, export format completeness and
  correctness, key rotation (old key rejected, new key accepted, entries intact),
  vault stats counts, history command outputs.

**Acceptance**

- `cargo test` passes all tests including TOTP test vectors.
- All M4 IPC commands (`get_history`, `get_commit_snapshot`, `restore_to_commit`,
  `get_totp`, `export_vault`, `rotate_master_key`, `get_vault_stats`) are registered
  and return correct results. Backup commands (`backup_push`, `backup_pull`) are
  deferred to M6.

---

## M5: React Frontend

**Goal:** The full UI is implemented and integrated with the backend. The app is usable
end-to-end.

**Deliverables**

- `frontend/api.js`: `invoke()` wrappers for every command from `design/ipc.md`.
- `frontend/totp.js`: RFC 6238 TOTP for live countdown preview before backend call.
- `frontend/validation.js`: title required, max lengths, URL format, TOTP secret format,
  expiry format, card number format.
- `frontend/entryUtils.js`: field descriptors per entry type.
- `frontend/limits.js`: field length constants.
- All components as listed in `design/tech_stack.md`:
  - `AppSetup.jsx`: unlock form (vault initialized) and first-run form (uninitialized).
  - `TagsSidebar.jsx`: tag list with counts, All Items link, Trash link, Settings link.
  - `EntryList.jsx`: active or trash entry list, search input.
  - `EntryDetail.jsx`: view/edit panel, all entry types, save/discard, delete button.
  - `HistoryDiffModal.jsx`: commit list, field diff viewer, restore button.
  - `SettingsList.jsx` and `SettingsPanel.jsx`: export, key rotation, backup push/pull, about stats.
  - `LoginFields.jsx`, `CardFields.jsx`, `NotesField.jsx`: type-specific field editors.
  - `TagsField.jsx`: add/remove tag chips.
  - `PasswordGenerator.jsx`: length, character class toggles, generate button.
  - `CopyBtn.jsx`, `EyeToggleBtn.jsx`, `SpinnerBtn.jsx`: shared controls.
  - `ResizeHandle.jsx`: drag-to-resize column boundaries.
  - `FieldSection.jsx`, `SidebarPanel.jsx`, `PanelHeader.jsx`: layout primitives.
  - `ErrorBoundary.jsx`: catch and display unexpected errors.
- Bootstrap 5 + Bootstrap Icons styling.
- Vitest tests: `totp.js` test vectors, `validation.js` edge cases, `PasswordGenerator`
  character class coverage, `api.js` mock-invoke wrappers, `CopyBtn`, `EyeToggleBtn`,
  `EntryList` render and filter, `TagsSidebar` counts.

**Acceptance**

- `npm test` passes.
- `cargo tauri dev` opens the full app; full CRUD lifecycle works in the UI; history modal
  shows diffs; TOTP codes update live; password generator produces valid passwords.

---

## M6: Backups and Release

**Goal:** Optional S3 backups are complete. The release build is packaged and all
integration tests pass.

**Deliverables**

- `backend/src/backup.rs`: S3-compatible upload and download using the AWS S3 API.
  `backup_push`: encrypt DB file with `encrypt_bytes_to_blob` under the root master key;
  upload with ISO 8601 timestamp in object key.
  `backup_pull`: download latest object; decrypt; atomically replace local DB file.
  `backup_on_save` trigger: after each write command, call `backup_push` for all targets.
- `backend/tests/`: full integration test suite covering the scenarios in `design/testing.md`:
  full vault lifecycle, root key rotation, history overflow, corrupt blob handling,
  cross-type isolation, export completeness, backup round-trip (with mock S3), TOTP
  multi-secret, concurrent session safety.
- `backend/tauri.conf.json`: bundle configuration for AppImage (Linux), dmg (macOS),
  and msi + nsis (Windows).
- Release build verification: `cargo tauri build` produces a working binary; vault
  survives a lock/unlock cycle on the release binary.

**Acceptance**

- `cargo test` passes all unit and integration tests.
- `npm test` passes all frontend tests.
- `cargo tauri build` succeeds and produces a runnable release binary.
- Backup push/pull round-trip works against a real S3-compatible endpoint (Cloudflare R2
  in manual smoke test) or mock S3 in CI.

---

## M7: Entry Sharing

**Goal:** Entry sharing between vault instances is implemented and tested.

**Deliverables**

- `backend/src/app.rs` sharing commands:
  - `generate_identity_keypair` produces ML-KEM-1024 + X448 keypair; stores SK encrypted
    under UMK, PK raw, in `key_store`.
  - `share_create(entry_id, recipient_pk_b64)`: encapsulate shared secret with recipient
    public key; encrypt `head_snapshot` JSON under shared secret; write `.sbsh` file.
  - `share_receive(file_path)`: open `.sbsh` file; decapsulate shared secret using own SK;
    decrypt snapshot; insert as new entry in vault.
  - Commands: `init_sharing`, `share_create`, `share_receive`, `get_identity_pk`.
- Frontend: share-create button in `EntryDetail`; share-receive in Settings panel.
- Rust unit tests: keypair generation and storage, share round-trip between two vault
  instances, wrong recipient key rejection, malformed `.sbsh` file rejection.

**Acceptance**

- `cargo test` passes all sharing tests.
- `.sbsh` file created by one vault instance is importable by another vault instance
  with the correct recipient keypair.
