use std::fs;
use std::path::{Path, PathBuf};

use assert_cmd::Command;
use base64::{engine::general_purpose, Engine as _};
use predicates::prelude::PredicateBooleanExt;
use predicates::str::contains;
use tempfile::TempDir;

fn write_config(config_path: &Path, db_path: &Path, username: &str, root_key_b64: &str) {
    let config = format!(
        "root_master_key_b64 = \"{root}\"\n\
         db_path = \"{db}\"\n\
         username = \"{user}\"\n\
         log_level = \"error\"\n",
        root = root_key_b64,
        db = db_path.display(),
        user = username,
    );

    fs::write(config_path, config).expect("write config");
}

fn setup_paths() -> (TempDir, PathBuf, PathBuf) {
    let dir = tempfile::tempdir().expect("tempdir");
    let db_path = dir.path().join("secbits.db");
    let config_path = dir.path().join("config.toml");
    (dir, db_path, config_path)
}

fn init(config_path: &Path) {
    Command::new(assert_cmd::cargo::cargo_bin!("secbits"))
        .args([
            "--config",
            config_path.to_str().expect("config path"),
            "init",
            "--username",
            "alice",
        ])
        .assert()
        .success();
}

#[test]
fn history_roundtrip_edit_restore_and_show() {
    let (_dir, db_path, config_path) = setup_paths();
    let root = general_purpose::STANDARD.encode(vec![9_u8; 256]);
    write_config(&config_path, &db_path, "alice", &root);
    init(&config_path);

    let initial = r#"{
      "title": "Mail",
      "username": "alice",
      "password": "p1",
      "notes": "note",
      "urls": ["https://example.com/"],
      "totpSecrets": [],
      "customFields": [],
      "tags": ["Work"],
      "timestamp": ""
    }"#;

    Command::new(assert_cmd::cargo::cargo_bin!("secbits"))
        .args([
            "--config",
            config_path.to_str().expect("config path"),
            "insert",
            "mail/google/main",
        ])
        .write_stdin(initial)
        .assert()
        .success();

    let edited = initial.replace("\"p1\"", "\"p2\"");
    Command::new(assert_cmd::cargo::cargo_bin!("secbits"))
        .args([
            "--config",
            config_path.to_str().expect("config path"),
            "edit",
            "mail/google/main",
        ])
        .write_stdin(edited)
        .assert()
        .success();

    let history_output = Command::new(assert_cmd::cargo::cargo_bin!("secbits"))
        .args([
            "--config",
            config_path.to_str().expect("config path"),
            "history",
            "mail/google/main",
        ])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let history_str = String::from_utf8(history_output).expect("utf8");
    let first_hash = history_str
        .lines()
        .nth(1)
        .expect("second line exists")
        .split_whitespace()
        .next()
        .expect("hash exists")
        .to_string();

    Command::new(assert_cmd::cargo::cargo_bin!("secbits"))
        .args([
            "--config",
            config_path.to_str().expect("config path"),
            "restore",
            "mail/google/main",
            "--commit",
            &first_hash,
        ])
        .assert()
        .success();

    Command::new(assert_cmd::cargo::cargo_bin!("secbits"))
        .args([
            "--config",
            config_path.to_str().expect("config path"),
            "show",
            "mail/google/main",
        ])
        .assert()
        .success()
        .stdout(contains("\"password\": \"p1\""));
}

#[test]
fn insert_rejects_invalid_path_hint() {
    let (_dir, db_path, config_path) = setup_paths();
    let root = general_purpose::STANDARD.encode(vec![7_u8; 256]);
    write_config(&config_path, &db_path, "alice", &root);
    init(&config_path);

    Command::new(assert_cmd::cargo::cargo_bin!("secbits"))
        .args([
            "--config",
            config_path.to_str().expect("config path"),
            "insert",
            "/invalid/path",
        ])
        .write_stdin("{}")
        .assert()
        .failure()
        .stdout(contains("invalid path hint").or(contains("command failed")));
}

#[test]
fn fuzzy_path_reports_ambiguous() {
    let (_dir, db_path, config_path) = setup_paths();
    let root = general_purpose::STANDARD.encode(vec![5_u8; 256]);
    write_config(&config_path, &db_path, "alice", &root);
    init(&config_path);

    let payload = r#"{"title":"x","username":"a","password":"p","notes":"","urls":[],"totpSecrets":[],"customFields":[],"tags":[],"timestamp":""}"#;

    for path in ["mail/google/main", "mail/github/main"] {
        Command::new(assert_cmd::cargo::cargo_bin!("secbits"))
            .args([
                "--config",
                config_path.to_str().expect("config path"),
                "insert",
                path,
            ])
            .write_stdin(payload)
            .assert()
            .success();
    }

    Command::new(assert_cmd::cargo::cargo_bin!("secbits"))
        .args([
            "--config",
            config_path.to_str().expect("config path"),
            "show",
            "mail/.*",
        ])
        .assert()
        .failure()
        .stdout(contains("path is ambiguous"));
}

#[test]
fn export_outputs_json_array() {
    let (_dir, db_path, config_path) = setup_paths();
    let root = general_purpose::STANDARD.encode(vec![4_u8; 256]);
    write_config(&config_path, &db_path, "alice", &root);
    init(&config_path);

    let payload = r#"{"title":"x","username":"a","password":"p","notes":"","urls":[],"totpSecrets":[],"customFields":[],"tags":[],"timestamp":""}"#;

    Command::new(assert_cmd::cargo::cargo_bin!("secbits"))
        .args([
            "--config",
            config_path.to_str().expect("config path"),
            "insert",
            "mail/google/main",
        ])
        .write_stdin(payload)
        .assert()
        .success();

    Command::new(assert_cmd::cargo::cargo_bin!("secbits"))
        .args([
            "--config",
            config_path.to_str().expect("config path"),
            "export",
        ])
        .assert()
        .success()
        .stdout(contains("[").and(contains("\"path\": \"mail/google/main\"")));
}

// §16.2 #8: insert with an empty path must fail with InvalidPathHint.
#[test]
fn insert_rejects_empty_path_hint() {
    let (_dir, db_path, config_path) = setup_paths();
    let root = general_purpose::STANDARD.encode(vec![6_u8; 256]);
    write_config(&config_path, &db_path, "alice", &root);
    init(&config_path);

    Command::new(assert_cmd::cargo::cargo_bin!("secbits"))
        .args([
            "--config",
            config_path.to_str().expect("config path"),
            "insert",
            "",
        ])
        .write_stdin("{}")
        .assert()
        .failure();
}

// §16.2 #8: insert with consecutive slashes must fail with InvalidPathHint.
#[test]
fn insert_rejects_consecutive_slash_path_hint() {
    let (_dir, db_path, config_path) = setup_paths();
    let root = general_purpose::STANDARD.encode(vec![8_u8; 256]);
    write_config(&config_path, &db_path, "alice", &root);
    init(&config_path);

    Command::new(assert_cmd::cargo::cargo_bin!("secbits"))
        .args([
            "--config",
            config_path.to_str().expect("config path"),
            "insert",
            "mail//google",
        ])
        .write_stdin("{}")
        .assert()
        .failure()
        .stdout(contains("invalid path hint").or(contains("command failed")));
}

// §16.2 #7: restore --commit <unknown_hash> must return CommitNotFound.
#[test]
fn restore_unknown_commit_returns_error() {
    let (_dir, db_path, config_path) = setup_paths();
    let root = general_purpose::STANDARD.encode(vec![11_u8; 256]);
    write_config(&config_path, &db_path, "alice", &root);
    init(&config_path);

    let payload = r#"{"title":"x","username":"a","password":"p","notes":"","urls":[],"totpSecrets":[],"customFields":[],"tags":[],"timestamp":""}"#;

    Command::new(assert_cmd::cargo::cargo_bin!("secbits"))
        .args([
            "--config",
            config_path.to_str().expect("config path"),
            "insert",
            "mail/google/main",
        ])
        .write_stdin(payload)
        .assert()
        .success();

    Command::new(assert_cmd::cargo::cargo_bin!("secbits"))
        .args([
            "--config",
            config_path.to_str().expect("config path"),
            "restore",
            "mail/google/main",
            "--commit",
            "000000000000",
        ])
        .assert()
        .failure()
        .stdout(contains("commit not found").or(contains("command failed")));
}

// §16.3 #7: 11 distinct edits must leave exactly 10 commits in history.
#[test]
fn commit_overflow_keeps_exactly_10_commits() {
    let (_dir, db_path, config_path) = setup_paths();
    let root = general_purpose::STANDARD.encode(vec![12_u8; 256]);
    write_config(&config_path, &db_path, "alice", &root);
    init(&config_path);

    let make_payload = |pw: &str| {
        format!(
            r#"{{"title":"x","username":"a","password":"{pw}","notes":"","urls":[],"totpSecrets":[],"customFields":[],"tags":[],"timestamp":""}}"#
        )
    };

    // Initial insert (commit 1)
    Command::new(assert_cmd::cargo::cargo_bin!("secbits"))
        .args([
            "--config",
            config_path.to_str().expect("config path"),
            "insert",
            "mail/google/main",
        ])
        .write_stdin(make_payload("p0"))
        .assert()
        .success();

    // 10 more distinct edits (commits 2..11)
    for idx in 1..=10 {
        Command::new(assert_cmd::cargo::cargo_bin!("secbits"))
            .args([
                "--config",
                config_path.to_str().expect("config path"),
                "edit",
                "mail/google/main",
            ])
            .write_stdin(make_payload(&format!("p{idx}")))
            .assert()
            .success();
    }

    // history must output exactly 10 non-empty lines (one per commit).
    let out = Command::new(assert_cmd::cargo::cargo_bin!("secbits"))
        .args([
            "--config",
            config_path.to_str().expect("config path"),
            "history",
            "mail/google/main",
        ])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();

    let commit_count = String::from_utf8(out)
        .expect("utf8")
        .lines()
        .filter(|l| !l.trim().is_empty())
        .count();

    assert_eq!(commit_count, 10, "history must contain exactly 10 commits after 11 changes");
}

// §16.3 #9: totp with multiple secrets must display all codes.
#[test]
fn totp_with_multiple_secrets_displays_all() {
    let (_dir, db_path, config_path) = setup_paths();
    let root = general_purpose::STANDARD.encode(vec![13_u8; 256]);
    write_config(&config_path, &db_path, "alice", &root);
    init(&config_path);

    // Two TOTP secrets; both are the RFC 6238 test secret for reproducibility.
    let payload = r#"{"title":"x","username":"a","password":"p","notes":"","urls":[],"totpSecrets":["GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ","GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"],"customFields":[],"tags":[],"timestamp":""}"#;

    Command::new(assert_cmd::cargo::cargo_bin!("secbits"))
        .args([
            "--config",
            config_path.to_str().expect("config path"),
            "insert",
            "mail/google/main",
        ])
        .write_stdin(payload)
        .assert()
        .success();

    let out = Command::new(assert_cmd::cargo::cargo_bin!("secbits"))
        .args([
            "--config",
            config_path.to_str().expect("config path"),
            "totp",
            "mail/google/main",
        ])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();

    let line_count = String::from_utf8(out)
        .expect("utf8")
        .lines()
        .filter(|l| !l.trim().is_empty())
        .count();

    assert_eq!(line_count, 2, "two TOTP secrets must produce two output lines");
}

// §15.8: rm must print the path and require explicit confirmation; "n" must abort.
#[test]
fn rm_requires_confirmation_and_n_aborts() {
    let (_dir, db_path, config_path) = setup_paths();
    let root = general_purpose::STANDARD.encode(vec![14_u8; 256]);
    write_config(&config_path, &db_path, "alice", &root);
    init(&config_path);

    let payload = r#"{"title":"x","username":"a","password":"p","notes":"","urls":[],"totpSecrets":[],"customFields":[],"tags":[],"timestamp":""}"#;

    Command::new(assert_cmd::cargo::cargo_bin!("secbits"))
        .args([
            "--config",
            config_path.to_str().expect("config path"),
            "insert",
            "mail/google/main",
        ])
        .write_stdin(payload)
        .assert()
        .success();

    // Answer "n" — must abort without deleting.
    Command::new(assert_cmd::cargo::cargo_bin!("secbits"))
        .args([
            "--config",
            config_path.to_str().expect("config path"),
            "rm",
            "mail/google/main",
        ])
        .write_stdin("n\n")
        .assert()
        .success()
        .stdout(contains("Aborted"));

    // Entry must still exist after the aborted rm.
    Command::new(assert_cmd::cargo::cargo_bin!("secbits"))
        .args([
            "--config",
            config_path.to_str().expect("config path"),
            "show",
            "mail/google/main",
        ])
        .assert()
        .success();
}

// §15.8: rm with "y" confirmation must delete the entry.
#[test]
fn rm_with_y_deletes_entry() {
    let (_dir, db_path, config_path) = setup_paths();
    let root = general_purpose::STANDARD.encode(vec![15_u8; 256]);
    write_config(&config_path, &db_path, "alice", &root);
    init(&config_path);

    let payload = r#"{"title":"x","username":"a","password":"p","notes":"","urls":[],"totpSecrets":[],"customFields":[],"tags":[],"timestamp":""}"#;

    Command::new(assert_cmd::cargo::cargo_bin!("secbits"))
        .args([
            "--config",
            config_path.to_str().expect("config path"),
            "insert",
            "mail/google/main",
        ])
        .write_stdin(payload)
        .assert()
        .success();

    Command::new(assert_cmd::cargo::cargo_bin!("secbits"))
        .args([
            "--config",
            config_path.to_str().expect("config path"),
            "rm",
            "mail/google/main",
        ])
        .write_stdin("y\n")
        .assert()
        .success()
        .stdout(contains("Deleted"));

    // Entry must be gone.
    Command::new(assert_cmd::cargo::cargo_bin!("secbits"))
        .args([
            "--config",
            config_path.to_str().expect("config path"),
            "show",
            "mail/google/main",
        ])
        .assert()
        .failure();
}
