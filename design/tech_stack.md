# Tech Stack

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

## Frontend Dependencies

Primary packages:

| Package | Purpose |
|---------|---------|
| `react` `react-dom` | UI framework |
| `@tauri-apps/api` | Tauri IPC, file dialogs, OS integration |
| `bootstrap` | CSS framework |
| `bootstrap-icons` | Icon set |
| `@noble/hashes` | HMAC-SHA1 for TOTP |

## Backend Dependencies

Primary crates:

| Crate | Purpose |
|-------|---------|
| `tauri` | Desktop shell, IPC command registration |
| `rusqlite` (bundled) | SQLite storage |
| `leancrypto-sys` | Ascon-Keccak-512 AEAD, HKDF-SHA3-512, ML-KEM-1024+X448 FFI |
| `serde` + `serde_json` | JSON serialization |
| `brotli` | Compression |
| `zeroize` | Secure memory clearing for key material |
| `thiserror` | Error types |
| `tracing` | Structured logging |
| `toml` | Config file parsing |

## Project Structure

```
secbits/
├── CLAUDE.md
├── README.md
├── design/
│
├── package.json
├── vite.config.js
├── index.html
│
├── frontend/                       React frontend
│   ├── main.jsx
│   ├── App.jsx                     root state, session flow, panel routing
│   ├── api.js                      invoke() wrappers for all IPC commands
│   ├── totp.js                     RFC 6238 TOTP
│   ├── validation.js
│   ├── entryUtils.js               entry type metadata
│   ├── limits.js
│   ├── index.css
│   └── components/
│       ├── AppSetup.jsx            vault unlock / first-run screen
│       ├── TagsSidebar.jsx
│       ├── EntryList.jsx
│       ├── EntryDetail.jsx
│       ├── HistoryDiffModal.jsx
│       ├── SettingsList.jsx
│       ├── SettingsPanel.jsx
│       ├── PasswordGenerator.jsx
│       ├── LoginFields.jsx
│       ├── CardFields.jsx
│       ├── NotesField.jsx
│       ├── TagsField.jsx
│       ├── CopyBtn.jsx
│       ├── EyeToggleBtn.jsx
│       ├── SpinnerBtn.jsx
│       ├── ResizeHandle.jsx
│       ├── FieldSection.jsx
│       ├── SidebarPanel.jsx
│       ├── PanelHeader.jsx
│       └── ErrorBoundary.jsx
│
└── backend/                        Rust backend (Tauri app)
    ├── Cargo.toml
    ├── tauri.conf.json
    ├── icons/
    └── src/
        ├── main.rs                 Tauri builder, command registration
        ├── commands.rs             #[tauri::command] handlers
        ├── state.rs                AppState: session keys, db handle
        ├── app.rs                  business logic
        ├── crypto.rs               HKDF, AEAD, blob encode/decode
        ├── model.rs                EntrySnapshot, HistoryObject, commit/delta
        ├── db.rs                   SQLite schema, CRUD
        ├── config.rs               TOML config load
        ├── backup.rs               S3 backup push/pull
        ├── compression.rs          Brotli wrappers
        └── error.rs                AppError enum
```

## UI Layout

Three-column desktop layout:

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

Column boundaries are draggable via `ResizeHandle`.

Mobile: stacked single-column view with back navigation.

## Dev Workflow

```bash
# One-time setup
npm install
cargo install tauri-cli

# Development
cargo tauri dev         # Vite dev server + Tauri window (hot reload)

# Production build
cargo tauri build       # platform binary in backend/target/release/bundle/

# Tests
cd backend && cargo test     # Rust unit + integration tests
npm test                     # Vitest frontend tests
```
