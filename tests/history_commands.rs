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
