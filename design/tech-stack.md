# Tech Stack — SecBits Tauri

## Overview

| Layer | Technology | Version |
|-------|-----------|---------|
| Desktop shell | Tauri 2 | 2.x |
| Frontend framework | React | 19 |
| Build tool | Vite | 6 |
| Backend language | Rust | 2024 edition |
| IPC bridge | Tauri invoke() | (Tauri 2) |
| Database | SQLite via rusqlite (bundled) | 0.37+ |
| AEAD cipher | Ascon-Keccak-512 via leancrypto-sys | 0.2+ |
| Key derivation | HKDF-SHA3-512 via leancrypto-sys | 0.2+ |
| Compression | brotli | 8.0 |
| Styling | Bootstrap 5 | 5.3 |
| Icons | Bootstrap Icons | 1.13+ |

---

## Frontend Dependencies (package.json)

| Package | Purpose |
|---------|---------|
| `react` `react-dom` | UI framework |
| `@tauri-apps/api` | Tauri invoke(), file dialog, OS integration |
| `bootstrap` | CSS framework |
| `bootstrap-icons` | Icon set |
| `@noble/hashes` | HMAC-SHA1 for TOTP (fallback if leancrypto WASM not loaded) |
| `brotli-wasm` | Brotli decompression in frontend (for export display) |

Dev dependencies:
| Package | Purpose |
|---------|---------|
| `vite` | Build tool |
| `@vitejs/plugin-react` | React fast refresh |
| `@tauri-apps/vite-plugin` | Tauri Vite integration |
| `vitest` | Frontend test runner |
| `@vitest/coverage-v8` | Coverage reports |

leancrypto WASM is not a primary frontend dependency in the Tauri app — all
encryption is done in the Rust backend. It may be included for the key rotation
helper UI.

---

## Rust Dependencies (Cargo.toml)

### Runtime

| Crate | Purpose |
|-------|---------|
| `tauri` | Desktop shell, IPC command registration |
| `tauri-plugin-shell` | (if needed for system interactions) |
| `rusqlite` (bundled feature) | SQLite with bundled sqlite3 |
| `leancrypto-sys` | FFI: Ascon-Keccak-512 AEAD + HKDF-SHA3-512 + ML-KEM-1024+X448 |
| `brotli` | Brotli compress/decompress |
| `serde` + `serde_json` | JSON serialization, IPC data types |
| `chrono` | Timestamps, ISO 8601 formatting |
| `base64` | Root master key decode |
| `data-encoding` | BASE32 for TOTP secret decoding |
| `hmac` + `sha1` | TOTP (RFC 6238 HMAC-SHA1) |
| `sha2` | SHA-256 commit hash |
| `rand` | Random salt and doc key generation |
| `zeroize` | Secure memory zeroing for key material |
| `thiserror` | `AppError` derive macro |
| `tracing` | Structured logging |
| `tracing-subscriber` | Log configuration |
| `toml` | Config file parsing |

### Dev / Test

| Crate | Purpose |
|-------|---------|
| `tempfile` | Temporary SQLite files in tests |
| `tokio` (test feature) | Async test support if needed |

---

## Project Structure

```
secbits/
├── CLAUDE.md                   Claude Code context
├── README.md                   High-level overview
├── design/                     Design documentation
│   ├── architecture.md
│   ├── crypto.md
│   ├── data-model.md
│   ├── features.md
│   ├── ipc.md
│   └── tech-stack.md           (this file)
│
├── package.json                Frontend dependencies
├── package-lock.json
├── vite.config.js              Vite + Tauri plugin config
├── index.html                  Entry HTML
│
├── src/                        React frontend
│   ├── main.jsx                React root mount
│   ├── App.jsx                 Root state, session flow, panel routing
│   ├── api.js                  invoke() wrappers for all IPC commands
│   ├── totp.js                 RFC 6238 TOTP (client-side countdown)
│   ├── validation.js           Field validation rules
│   ├── entryUtils.js           Entry type metadata (fields, labels, icons)
│   ├── limits.js               Field length limits
│   ├── index.css               Global styles
│   └── components/
│       ├── AppSetup.jsx        Vault unlock / first-run screen
│       ├── TagsSidebar.jsx     Tag navigation, user info, settings/trash toggle
│       ├── EntryList.jsx       Filtered entry list, New Entry button
│       ├── EntryDetail.jsx     Entry editor (all types)
│       ├── LoginFields.jsx     Username/password fields
│       ├── CardFields.jsx      Credit card fields
│       ├── NotesField.jsx      Notes textarea
│       ├── TagsField.jsx       Tag input
│       ├── PasswordGenerator.jsx  Random password generator dialog
│       ├── HistoryDiffModal.jsx   Commit history + field diff viewer
│       ├── SettingsList.jsx    Settings menu
│       ├── SettingsPanel.jsx   Settings pages (export, security, backup, about)
│       ├── SidebarPanel.jsx    Sidebar base layout
│       ├── PanelHeader.jsx     Header bar with back/close controls
│       ├── CopyBtn.jsx         Copy-to-clipboard with flash feedback
│       ├── EyeToggleBtn.jsx    Show/hide password toggle
│       ├── SpinnerBtn.jsx      Async button with loading spinner
│       ├── ResizeHandle.jsx    Draggable column width adjuster
│       ├── FieldSection.jsx    Labeled field section wrapper
│       └── ErrorBoundary.jsx   React error fallback UI
│
└── src-tauri/                  Rust backend (Tauri app)
    ├── Cargo.toml
    ├── tauri.conf.json         Tauri config (bundle ID, window, permissions)
    ├── icons/                  App icons
    └── src/
        ├── main.rs             Tauri builder, command registration
        ├── commands.rs         #[tauri::command] handlers (thin wrappers)
        ├── state.rs            AppState: Mutex<DbConn>, session keys, config
        ├── app.rs              Business logic (auth, CRUD, history, TOTP, export)
        ├── crypto.rs           leancrypto FFI: HKDF, AEAD, blob encode/decode
        ├── model.rs            EntrySnapshot, HistoryObject, commit/delta
        ├── db.rs               SQLite schema, CRUD queries
        ├── config.rs           TOML config load and validation
        ├── backup.rs           S3 backup push/pull
        ├── compression.rs      Brotli compress/decompress
        └── error.rs            AppError enum (thiserror + serde)
```

---

## UI Layout

Three-column desktop layout (adapted from `main` branch):

```
┌────────────────┬──────────────────────┬──────────────────────────┐
│  Column 1      │  Column 2            │  Column 3                │
│  TagsSidebar   │  EntryList           │  EntryDetail             │
│                │    or                │    or                    │
│  - All Items   │  SettingsList        │  HistoryDiffModal        │
│  - Trash       │                      │    or                    │
│  - Settings    │                      │  SettingsPanel           │
│  - Tags...     │                      │                          │
└────────────────┴──────────────────────┴──────────────────────────┘
```

Columns 1–2 and 2–3 boundaries are draggable via `ResizeHandle`.

Mobile: stacked single-column view with back navigation.

---

## Config File

TOML at `~/.config/secbits/config.toml` (or `SECBITS_CONFIG` env var).

```toml
root_master_key_b64 = "<base64-encoded ≥256-byte key>"
db_path             = "~/.local/share/secbits/vault.db"
username            = "alice"

# Optional
backup_on_save      = false
log_level           = "warn"

[targets.r2]
endpoint   = "https://<account>.r2.cloudflarestorage.com"
bucket     = "secbits-backup"
access_key = "<key>"
secret_key = "<secret>"
region     = "auto"
```

---

## Dev Workflow

```bash
# One-time setup
npm install
cargo install tauri-cli

# Development
cargo tauri dev         # Vite dev server + Tauri window (hot reload)

# Production build
cargo tauri build       # Produces platform binary in src-tauri/target/release/bundle/

# Tests
cd src-tauri && cargo test   # Rust unit + integration tests
npm test                     # Vitest frontend tests
```

---

## Source Branches

| Branch | Role |
|--------|------|
| `tauri` | This branch — Tauri desktop app |
| `main` | React + Vite + Firebase web app — UI source |
| `rust` | Offline-first Rust CLI — backend logic source |

Frontend components were adapted from `main`. Rust modules (`crypto.rs`,
`model.rs`, `db.rs`, `config.rs`, `backup.rs`, `compression.rs`, `error.rs`)
were adapted from `rust`. The Tauri-specific files (`main.rs`, `commands.rs`,
`state.rs`) and the IPC-adapted `app.rs` are new in this branch.
