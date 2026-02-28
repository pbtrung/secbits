# SecBits — CLAUDE.md

## What

Offline-first desktop password manager. Tauri 2 shell wraps a React/Vite frontend
and a Rust backend. All data is stored in a local SQLite database. No server or
cloud dependency is required; S3-compatible encrypted backups are optional.

## Tech Stack

```
Tauri 2         — desktop shell, IPC bridge, native OS integration
React 19        — frontend UI framework
Vite            — frontend build tool and dev server
Rust 2024       — backend logic exposed as Tauri commands
rusqlite        — SQLite storage (bundled sqlite)
leancrypto-sys  — Ascon-Keccak-512 AEAD + HKDF-SHA3-512 FFI
brotli          — compression before encryption
Bootstrap 5     — CSS framework
```

## Planned Project Structure

```
secbits/
├── CLAUDE.md
├── README.md
├── design/                     design docs (see below)
├── package.json                frontend dependencies
├── vite.config.js
├── index.html
├── src/                        React frontend
│   ├── main.jsx
│   ├── App.jsx                 root state, session flow, IPC calls
│   ├── api.js                  Tauri invoke() wrappers
│   ├── crypto.js               client-side crypto (leancrypto WASM, for key rotation UI)
│   ├── totp.js                 RFC 6238 TOTP
│   ├── validation.js           field validation
│   ├── entryUtils.js           entry type metadata
│   ├── limits.js               field length limits
│   └── components/             UI components
│       ├── AppSetup.jsx        unlock / first-run setup
│       ├── TagsSidebar.jsx
│       ├── EntryList.jsx
│       ├── EntryDetail.jsx
│       ├── HistoryDiffModal.jsx
│       ├── SettingsList.jsx
│       ├── SettingsPanel.jsx
│       └── ...
├── src-tauri/                  Rust backend
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   └── src/
│       ├── main.rs             Tauri app entry point
│       ├── commands.rs         #[tauri::command] handlers
│       ├── state.rs            AppState (session, db handle)
│       ├── app.rs              business logic
│       ├── crypto.rs           HKDF + AEAD + blob encode/decode
│       ├── model.rs            EntrySnapshot, HistoryObject, delta logic
│       ├── db.rs               SQLite CRUD
│       ├── config.rs           TOML config load
│       ├── backup.rs           S3-compatible backup push/pull
│       ├── compression.rs      Brotli wrappers
│       └── error.rs            AppError enum
└── src-tauri/leancrypto/       leancrypto C headers + link config
```

## Module Map (Rust backend)

| Module | Responsibility |
|--------|----------------|
| `commands.rs` | `#[tauri::command]` handlers; thin — delegates to `app.rs` |
| `state.rs` | `AppState` struct: `Mutex<DbConn>`, session keys, config |
| `app.rs` | Business logic: auth, entry CRUD, history, TOTP, export |
| `crypto.rs` | leancrypto FFI: HKDF, Ascon-Keccak-512 AEAD, blob encode/decode |
| `model.rs` | `EntrySnapshot`, `HistoryObject`, commit/delta logic |
| `db.rs` | SQLite schema, CRUD queries |
| `config.rs` | TOML config load and validation |
| `backup.rs` | S3 backup push/pull |
| `compression.rs` | Brotli compress/decompress |
| `error.rs` | `AppError` enum (thiserror), serialized to frontend as JSON |

## Key Invariants

- **Blob layout**: `salt(64) || ciphertext || tag(64)`. Details: `design/crypto.md`.
- **History object**: `head` + `head_snapshot` + `commits[]`. Details: `design/data_model.md`.
- **Key hierarchy**: root_master_key → user_master_key → per-entry doc_key. Details: `design/crypto.md`.
- **Max history**: 20 commits per entry.
- **Oldest commit**: always carries a full-snapshot delta (reconstruction baseline).
- **Dedup**: if content hash of new snapshot equals current head, no commit is appended.
- **Session**: decrypted keys live only in `AppState` (Rust heap) and React state (JS heap). Nothing written to disk beyond the encrypted SQLite DB.
- **Errors**: `AppError` variants serialize to JSON via serde; frontend receives structured error objects, not raw strings.

## IPC Command Surface

See `design/ipc.md` for the full command list, parameter types, and return shapes.

Quick reference:
```
unlock_vault(password)            → session token
lock_vault()
list_entries(filter?)             → Entry[]
get_entry(id)                     → EntryDetail
create_entry(type, snapshot)      → Entry
update_entry(id, snapshot)        → Entry
delete_entry(id)                  → void (moves to trash)
restore_entry(id)                 → Entry (moves out of trash)
purge_entry(id)                   → void (permanent delete)
get_history(id)                   → Commit[]
restore_to_commit(id, hash)       → Entry
get_totp(id)                      → { code, remaining_secs }
export_vault()                    → JSON string
rotate_master_key(new_key)        → void
backup_push(target?)              → void
backup_pull(target)               → void
```

## Design Docs Index

| File | Contents |
|------|---------|
| `design/architecture.md` | Architecture decisions and rationale |
| `design/crypto.md` | Cipher spec, key hierarchy, blob format, constants |
| `design/data_model.md` | Entry schema, history object, commit/delta rules |
| `design/features.md` | Full feature surface |
| `design/ipc.md` | Tauri IPC command surface: params, return types, errors |
| `design/tech_stack.md` | Dependencies, versions, project layout |

## Config

TOML file at `~/.config/secbits/config.toml` (or `SECBITS_CONFIG` env var).

Required fields:
- `root_master_key_b64` — base64-encoded root master key (≥256 bytes raw)
- `db_path` — path to SQLite database file
- `username` — vault username

Optional:
- `backup_on_save` — auto-push after write commands (bool)
- `log_level` — tracing level (`error|warn|info|debug|trace`)
- `[targets.<name>]` — S3-compatible backup targets

## Build & Test

```bash
npm install                  # install frontend deps
cargo tauri dev              # dev mode (Vite HMR + Tauri)
cargo tauri build            # release binary
cd src-tauri && cargo test   # Rust tests
npm test                     # Vitest frontend tests
```
