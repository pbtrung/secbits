# SecBits — CLAUDE.md

## What

Offline-first CLI password manager in Rust. Single binary with pass-style path UX.
Stores entries in a local SQLite database. All secrets are encrypted at rest.

Tech stack: Rust 2021, `clap` CLI, `rusqlite` DB, `leancrypto` FFI (Ascon-Keccak-512 AEAD + HKDF-SHA3-512 + ML-KEM-1024+X448), `brotli` compression, `serde_json` for history serialization.

## Why

Replaces the prior JS/React browser-based app. Goals: offline-first, no server required, post-quantum-safe sharing, standard pass-style UX.

## How

```bash
cargo build                        # build
cargo test                         # unit + integration tests
SECBITS_FORCE_INTERACTIVE=1 ...    # force interactive prompts in tests
```

Config file (TOML): `~/.config/secbits/config.toml` or `--config <path>` / `$SECBITS_CONFIG`.

Required fields: `root_master_key_b64`, `db_path`, `username`.
Optional: `backup_on_save`, `log_level`, `log_target`, `log_time`, `[targets.<name>]`.

## Module Map

| Module          | Responsibility                                                  |
|-----------------|-----------------------------------------------------------------|
| `src/cli.rs`    | Clap argument structs and subcommands                           |
| `src/app.rs`    | Command dispatch, all handler functions, interactive prompts    |
| `src/crypto.rs` | leancrypto FFI wrappers (HKDF, AEAD, blob encode/decode)        |
| `src/model.rs`  | `EntrySnapshot`, `HistoryObject`, commit/delta logic            |
| `src/db.rs`     | SQLite connection, schema migrations, CRUD                      |
| `src/config.rs` | TOML config load and validation                                 |
| `src/backup.rs` | S3-compatible backup push/pull (M8, stub until implemented)     |
| `src/compression.rs` | Brotli compress/decompress wrappers                        |
| `src/logging.rs` | tracing-subscriber init with optional timestamp/target         |
| `src/error.rs`  | `AppError` enum (thiserror)                                     |

## Implementation Milestones

M1–M7 complete. Remaining:

- **M8** Backup: config `[targets]` parsing, S3 push/pull, `backup_on_save` trigger.
- **M9** Diff accuracy: Unicode NFC normalization, field-level hashes.
- **M10** Sharing: ML-KEM-1024+X448 keypair, schema migration 2, `share-init/pubkey/share/share-receive`.
- **M11** Release: packaging, docs.

## Key Invariants

- Blob layout: `salt(64) || ciphertext || tag(64)`. Details: `agent_docs/crypto.md`.
- History object: `head` + `head_snapshot` + `commits[]`. Details: `agent_docs/model.md`.
- Logging writes to **stdout** (tracing default). Integration tests assert on `.stdout(contains(...))`.
- `insert`/`edit` log invocation at DEBUG, not INFO (keeps interactive prompts clean).
- No co-author lines in commits.

## agent_docs Index

| File                       | Contents                                                  |
|----------------------------|-----------------------------------------------------------|
| `agent_docs/crypto.md`     | Crypto constants, key hierarchy, blob format              |
| `agent_docs/model.md`      | History object schema, commit/delta rules, dedup/restore  |
| `agent_docs/backup.md`     | S3 backup push/pull design, blob format, safe replace     |
| `agent_docs/sharing.md`    | ML-KEM-1024+X448 protocol, share payload binary format    |
| `agent_docs/testing.md`    | Test strategy, negative tests, integration test patterns  |
