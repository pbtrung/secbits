# Architecture — SecBits Tauri

Architecture decisions and their rationale.

---

## Tauri 2 Desktop Shell

**Decision:** Package the app as a Tauri 2 desktop binary wrapping a React/Vite
frontend and a Rust backend.

**Why:** Tauri gives native desktop integration (file system access, OS keychain,
system tray) while keeping the frontend in the web stack the UI was designed for.
The Rust backend runs in the same process as the Tauri shell, so IPC is a function
call — no network round-trip, no serialization overhead beyond JSON.

Compared to Electron: Tauri uses the OS webview and a Rust (not Node) backend,
producing much smaller binaries and a much smaller attack surface.

---

## Offline-First: All Data in Local SQLite

**Decision:** The single source of truth is a local SQLite file. No server, no
sync daemon, no network dependency for normal operation.

**Why:** The `main` branch web app required a live Firebase + Cloudflare Worker +
R2 stack to read any entry. A power outage, network partition, or service shutdown
made data inaccessible. A local SQLite file works on an air-gapped machine and is
trivially backed up by copying one file.

The `rust` branch established this model for the CLI. The Tauri app inherits it
with the same database schema and crypto layer, adding a graphical shell on top.

---

## Tauri IPC Replaces CLI and Firebase/Worker API

**Decision:** Rust logic is exposed as `#[tauri::command]` handlers instead of
clap CLI subcommands (from `rust`) or fetch()-based Worker API calls (from `main`).

**Why:** The CLI pattern (argument parsing, stdout output, interactive prompts) does
not map to a GUI. The web API pattern (HTTP, Firebase tokens, CORS) does not map
to a local process. Tauri's `invoke()` bridge is a typed, async IPC mechanism that
fits both: the frontend calls `invoke("create_entry", { ... })` and the Rust handler
returns a JSON-serializable value or a structured error.

This means:
- `src/api.js` in the frontend wraps `invoke()` calls, replacing the fetch-based
  api.js from `main`.
- `src-tauri/src/commands.rs` registers handlers, replacing `src/cli.rs` + `src/app.rs`'s
  clap dispatch from `rust`.
- Business logic in `app.rs`, `crypto.rs`, `model.rs`, `db.rs` is reused unchanged
  (or near-unchanged) from `rust`.

---

## Two-Level Key Wrapping (Retained from Rust Branch)

**Decision:** Root master key → user master key → per-entry doc key.

**Why:** The web app used a single root master key that encrypted the entire vault
blob. The CLI used two-level wrapping. For the Tauri app, two-level wrapping is
kept because:
1. Root key rotation re-encrypts only the 192-byte user master key blob, not every entry.
2. Per-entry doc keys limit blast radius: a leaked doc key compromises one entry.
3. The existing Rust code (tested) implements this correctly.

See `design/crypto.md` for the full key hierarchy.

---

## React Frontend Kept Largely Intact

**Decision:** Reuse UI components from `main` with minimal changes. Replace
Firebase/Worker API calls with `invoke()` wrappers.

**Why:** The component structure (3-column layout, entry types, history diff modal,
password generator, TOTP display) is complete and tested. Rewriting from scratch
would be wasteful. The only layer that changes is `api.js` — the data fetching
layer — which is already isolated from components.

Changes needed:
- `AppSetup.jsx`: replace Firebase login with vault unlock (root master key prompt).
- `api.js`: replace all `fetch()` calls with `invoke()` calls.
- `App.jsx`: remove Firebase session management; use Tauri's session state.
- No changes needed to: `EntryDetail`, `EntryList`, `TagsSidebar`, `HistoryDiffModal`,
  `PasswordGenerator`, field components, `totp.js`, `validation.js`, etc.

---

## Session State Split Between Rust and React

**Decision:** Unlocked session keys live in Rust (`AppState`); display state (current
entry, filter, panel) lives in React.

**Why:** Keeping keys in Rust means they are never serialized to JSON or exposed in
the JS heap beyond what's needed for display. React manages ephemeral UI state —
which panel is open, which entry is selected — that has no security implications.
This is a clean separation: Rust owns secrets, React owns presentation.

On lock, Rust zeroes keys in `AppState` (via `zeroize`). React state clears on
re-render.

---

## leancrypto WASM Not Used for Primary Crypto in Frontend

**Decision:** All encryption/decryption is done by the Rust backend. The frontend
does not use the leancrypto WASM bundle for primary vault operations.

**Why:** In the `main` branch, the frontend performed client-side encryption before
sending data to R2. In the Tauri app, there is no network send — the Rust backend
writes directly to SQLite. Performing crypto in Rust is simpler, better tested
(existing test suite), and avoids loading a WASM bundle for operations that Rust
already handles natively.

The leancrypto WASM bundle may still be used for the key rotation UI helper
(verifying the new root key format client-side before sending it to Rust) but is
not on the critical encryption path.

---

## Structured Error Propagation via Tauri IPC

**Decision:** `AppError` variants are serialized to JSON by Tauri and received by
the frontend as structured objects, not raw strings.

**Why:** The CLI used `eprintln!` and exit codes. A GUI needs structured errors to
display appropriate messages (e.g., "Wrong master key" vs "Database not found" vs
"Entry already exists"). Tauri serializes `Err(AppError::WrongRootMasterKey)` as
`{ "type": "WrongRootMasterKey" }` which the frontend can pattern-match.

---

## History Cap: 20 Commits

**Decision:** Maximum 20 commits per entry (up from 10 in the CLI).

**Why:** The web app (`main`) used 20 commits. The GUI has a history diff modal
that makes version history more discoverable and useful. 20 commits is a reasonable
cap for a GUI app where users interact frequently. Storage cost is negligible —
deltas are small and the whole history is Brotli-compressed before storage.

---

## Backups: S3-Compatible Encrypted Push/Pull

**Decision:** Optional encrypted backups to any S3-compatible endpoint (Cloudflare
R2, AWS S3, GCS, MinIO, etc.).

**Why:** Local-only storage is a single point of failure. Encrypted S3 backups
give off-site redundancy without exposing plaintext to the storage provider.
Supporting the S3 API as the common denominator avoids per-provider code paths.

Backup is opt-in. When `backup_on_save = true` in config, a push is triggered
automatically after each write command. Otherwise the user triggers it from Settings.
