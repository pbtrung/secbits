# Testing — SecBits

## Test Layout

- `src/<module>.rs` — unit tests in `#[cfg(test)]` blocks inside each module
- `tests/auth_lifecycle.rs` — init/auth/session integration tests
- `tests/cli_help.rs` — clap argument validation tests
- `tests/history_commands.rs` — insert/edit/show/history/restore/totp/export/rm integration tests

## Running Tests

```bash
cargo test                         # all tests
cargo test --lib                   # unit tests only
cargo test --test history_commands # one integration test file
```

## Key Testing Notes

- `tracing_subscriber::fmt()` writes to **stdout** by default. Integration tests use `.stdout(contains(...))` for log/error message assertions.
- `cli_help.rs` uses `.stderr(contains("required"))` for missing argument errors (clap writes those to stderr).
- `SECBITS_FORCE_INTERACTIVE=1` env var forces interactive prompt path even when stdin is piped — used in interactive input tests.
- Integration tests use `tempfile::tempdir()` for isolated DB + config paths.
- `assert_cmd` spawns the binary; always pass `--config <path>` pointing to the temp config.

## Integration Test Pattern

```rust
fn setup_paths() -> (TempDir, PathBuf, PathBuf) {
    let dir = tempfile::tempdir().expect("tempdir");
    (dir, dir.path().join("secbits.db"), dir.path().join("config.toml"))
}

fn write_config(config_path, db_path, username, root_key_b64) { ... }

// init, then insert, then assert
Command::new(cargo_bin!("secbits"))
    .args(["--config", &config_path, "insert", "mail/google/main"])
    .write_stdin(json_payload)
    .assert()
    .success()
    .stdout(contains("Saved `mail/google/main`"));
```

## Critical Test Coverage Areas

### Crypto
- Encrypt/decrypt round-trip; same plaintext produces distinct ciphertexts (random salt).
- Tampered ciphertext/tag → `DecryptionFailedAuthentication`.
- `MASTER_BLOB_LEN = 192` exactly.

### Auth
- `init` is idempotent.
- Wrong root key → `WrongRootMasterKey`.
- User not found → `UserNotFound`.

### History
- Initial commit: `delta: None`, `parent: None`, `changed` lists populated fields.
- 11 edits → exactly 10 commits; oldest has full-snapshot `delta`.
- Restore to HEAD → no-op (returns false).
- `restore --commit <unknown>` → `CommitNotFound`.

### Path
- Fuzzy regex match.
- Multiple matches → `PathAmbiguous`.
- `insert` with leading slash / consecutive slashes / empty → `InvalidPathHint`.

### Interactive
- `SECBITS_FORCE_INTERACTIVE=1` tests password masking, TOTP re-prompting, custom fields.
- Invalid TOTP in interactive → re-prompt (not error).
- Invalid TOTP in piped mode → fail with `InvalidTotpSecret`.
- Summary after insert/edit does not contain password or TOTP secret values.

### Backup (M8)
- `backup push --all` requires at least one configured target → `BackupTargetNotConfigured`.
- `backup push` with neither `--target` nor `--all` → CLI arg error.
- Round-trip: push → delete local DB → pull → verify entries intact.
- `backup pull` cancellation leaves existing DB intact.
- `backup_on_save = true` auto-triggers after insert/edit/restore.

### Sharing (M10)
- Hybrid KEM round-trip: encapsulate → decapsulate → shared secret matches.
- Share payload encode/decode round-trip.
- `share-pubkey` before `share-init` → `ShareKeysNotInitialized`.
- Tampered KEM ciphertext → `ShareDecryptFailed`.
- Wrong recipient username → `ShareNotForThisUser`.
