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

Test coverage requirements per milestone: see `agent_docs/plan.md`.
