# Architecture

Architecture decisions and their rationale.

## Tauri 2 Desktop Shell

**Decision:** Package the app as a Tauri 2 desktop binary wrapping a React/Vite
frontend and a Rust backend. The bundle identifier is `com.secbits.desktop`.

**Why:** Tauri gives native desktop integration (file system access, OS keychain,
system tray) while keeping the frontend in the web stack. The Rust backend runs in
the same process as the Tauri shell, so IPC is a function call; no network
round-trip, no serialization overhead beyond JSON.

Compared to Electron: Tauri uses the OS webview and a Rust (not Node) backend,
producing much smaller binaries and a much smaller attack surface.

## Offline-First: All Data in Local SQLite

**Decision:** The single source of truth is a local SQLite file. No server, no
sync daemon, no network dependency for normal operation.

**Why:** A local SQLite file works on an air-gapped machine and is trivially backed
up by copying one file. There is no service whose outage, network partition, or
shutdown can make data inaccessible.

## Tauri IPC Command Bridge

**Decision:** Rust logic is exposed as `#[tauri::command]` handlers. The frontend
calls `invoke("command_name", { ... })` and receives a JSON-serializable value or
a structured error.

**Why:** Tauri's `invoke()` bridge is a typed, async IPC mechanism that fits the
GUI model cleanly: no argument parsing, no stdout formatting, no HTTP round-trips.
`src/api.js` wraps all `invoke()` calls, keeping IPC details out of components.
`src-tauri/src/commands.rs` registers handlers; `app.rs` contains the business
logic they delegate to.

## Two-Level Key Wrapping

**Decision:** Root master key → user master key → per-entry doc key.

**Why:**
1. Root key rotation re-encrypts only the 192-byte user master key blob, not every entry.
2. Per-entry doc keys limit blast radius: a leaked doc key compromises one entry only.

See `design/crypto.md` for the full key hierarchy.

## React Frontend

**Decision:** React 19 + Vite for the frontend. Three-column layout with
tag sidebar, entry list, and entry detail/editor panels.

**Why:** React's component model maps naturally to the panel-based UI. Vite's
fast HMR speeds up development. The component boundaries (sidebar, list, detail,
modals) keep each panel independently testable.

`api.js` is the only module that calls `invoke()`; all components receive data
as props or through state, making them agnostic to the IPC layer.

## Session State Split Between Rust and React

**Decision:** Unlocked session keys live in Rust (`AppState`); display state
(current entry, active filter, open panel) lives in React.

**Why:** Keeping keys in Rust means they are never serialized to JSON or exposed
in the JS heap beyond what's needed for display. React manages ephemeral UI state
that has no security implications. This is a clean separation: Rust owns secrets,
React owns presentation.

On lock, Rust zeroes keys in `AppState` (via `zeroize`). React state clears on
re-render.

## Rust Backend Handles All Crypto

**Decision:** All encryption, decryption, and cryptographic random number
generation is performed by the Rust backend. The frontend performs no crypto.

**Why:** The Rust backend writes directly to SQLite and has direct access to
leancrypto via FFI and to the OS CSPRNG (`OsRng`). Keeping the entire crypto
path in Rust means the security-critical surface is one module (`crypto.rs`),
independently testable without a browser environment, and auditable without
reasoning about JavaScript runtime behaviour.

This extends to random byte generation: the Security settings page calls
`generate_root_master_key()` IPC to obtain a 256-byte key from `OsRng`;
the bytes are returned base64-encoded for display. The browser never generates
or validates key material.

## Structured Error Propagation via Tauri IPC

**Decision:** `AppError` variants are serialized to JSON by Tauri and received
by the frontend as structured objects, not raw strings.

**Why:** A GUI needs structured errors to display appropriate messages (e.g.,
"Wrong master key" vs "Database not found" vs "Entry already exists"). Tauri
serializes `Err(AppError::WrongRootMasterKey)` as `{ "type": "WrongRootMasterKey" }`
which the frontend can pattern-match.

## History Cap: 20 Commits

**Decision:** Maximum 20 commits per entry.

**Why:** The history diff modal makes version history discoverable and useful,
so a higher cap is warranted. 20 commits is a reasonable bound for typical usage.
Storage cost is negligible; deltas are small and the full history is
Brotli-compressed before storage.

## Linux Window Management: GDK X11 Backend

**Decision:** On Linux, `main.rs` sets `GDK_BACKEND=x11` before Tauri
initializes, forcing GTK to use the X11 backend (via XWayland on Wayland
sessions).

**Why:** Tauri's GTK layer uses libdecor for client-side decorations (CSD) on
Wayland. Under KDE Plasma + Wayland this prevents the window manager from
applying its own server-side decorations, causing missing title bars, broken
close and minimize buttons, and non-functional resize borders.

Forcing X11 hands decoration responsibility to KDE's X11 window manager, which
handles close, minimize, maximize, and drag-to-resize natively. The tradeoff
(XWayland rather than native Wayland) is acceptable: window management works
correctly and there are no visual artifacts or protocol errors.

## Backups: S3-Compatible Encrypted Push/Pull

**Decision:** Optional encrypted backups to any S3-compatible endpoint (Cloudflare
R2, AWS S3, GCS, MinIO, etc.).

**Why:** Local-only storage is a single point of failure. Encrypted S3 backups
give off-site redundancy without exposing plaintext to the storage provider.
Supporting the S3 API as the common denominator avoids per-provider code paths.

Backup is opt-in. When `backup_on_save = true` in config, a push is triggered
automatically after each write command. Otherwise the user triggers it from Settings.
