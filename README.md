# SecBits

Offline-first, end-to-end encrypted desktop password manager.

Built with Tauri 2 (Rust backend, React + Vite frontend, local SQLite storage).
No server required. No cloud dependency. Your data never leaves your machine unless
you configure an optional S3-compatible encrypted backup.

## Features

- **Three entry types**: Login, Secure Note, Credit Card
- **Version history**: up to 20 commits per entry with field-level diffs and restore
- **TOTP**: live RFC 6238 codes with 30-second countdown
- **Password generator**: configurable length, character classes
- **Tags and full-text search**: filter by tag or search across titles and usernames
- **Trash**: soft delete with restore; permanent delete from trash
- **Export**: download full decrypted vault as JSON
- **Encrypted backups**: optional S3-compatible push/pull (Cloudflare R2, AWS S3, etc.)

## Security

- **Cipher**: Ascon-Keccak-512 AEAD with 512-bit key, IV, and tag (post-quantum safe)
- **Key derivation**: HKDF-SHA3-512 with a fresh 64-byte random salt per encryption
- **Two-level key wrapping**: root master key, user master key, per-entry doc key
- **Compression**: Brotli before encryption; compressed size is hidden inside the AEAD envelope
- **In-memory session**: decrypted data lives only in the Rust process and JS heap;
  nothing written to disk beyond the encrypted SQLite database
- **No network calls**: all operations are local; backups are opt-in

See `design/crypto.md` for the full cipher spec.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop shell | Tauri 2 |
| Frontend | React 19, Vite |
| Backend | Rust 2024 edition |
| Storage | SQLite via rusqlite (bundled) |
| Crypto | leancrypto (Ascon-Keccak-512 + HKDF-SHA3-512 + ML-KEM-1024 + X448) |
| Compression | Brotli |
| Styling | Bootstrap 5 |

## Development

```bash
npm install          # install frontend dependencies
cargo tauri dev      # start dev server (Vite + Tauri)
cargo tauri build    # produce release binary
cargo test           # run Rust unit/integration tests
npm test             # run Vitest frontend tests
```

## Config

TOML file at `~/.config/secbits/config.toml` (or `SECBITS_CONFIG` env var).

```toml
# Required
root_master_key_b64 = "<base64-encoded key, minimum 256 bytes raw>"
db_path             = "~/.local/share/secbits/vault.db"
username            = "alice"

# Optional
backup_on_save      = false
log_level           = "warn"   # error | warn | info | debug | trace

# One or more S3-compatible backup targets (optional)
[targets.r2]
endpoint   = "https://<account>.r2.cloudflarestorage.com"
bucket     = "secbits-backup"
access_key = "<key>"
secret_key = "<secret>"
region     = "auto"

[targets.aws]
endpoint   = "https://s3.amazonaws.com"
bucket     = "my-secbits-backup"
access_key = "<key>"
secret_key = "<secret>"
region     = "us-east-1"
```

## Design Docs

- `design/architecture.md`: system architecture and decisions
- `design/crypto.md`: cipher spec, key hierarchy, blob format
- `design/data_model.md`: entry schema, history object, commit/delta rules
- `design/features.md`: full feature surface
- `design/ipc.md`: Tauri IPC command surface
- `design/tech_stack.md`: dependencies and project structure
