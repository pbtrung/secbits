use std::fs;
use std::path::{Path, PathBuf};

use assert_cmd::Command;
use base64::{engine::general_purpose, Engine as _};
use predicates::str::contains;
use tempfile::TempDir;

fn write_config(config_path: &Path, db_path: &Path, username: &str, root_key_b64: &str) {
    let config = format!(
        "root_master_key_b64 = \"{root}\"\n\
         db_path = \"{db}\"\n\
         username = \"{user}\"\n",
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

#[test]
fn init_sets_up_user_master_key_and_is_idempotent() {
    let (_dir, db_path, config_path) = setup_paths();

    let root = general_purpose::STANDARD.encode(vec![9_u8; 256]);
    write_config(&config_path, &db_path, "alice", &root);

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
fn wrong_root_key_fails_with_explicit_error() {
    let (_dir, db_path, config_path) = setup_paths();

    let good_root = general_purpose::STANDARD.encode(vec![1_u8; 256]);
    write_config(&config_path, &db_path, "alice", &good_root);

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

    let wrong_root = general_purpose::STANDARD.encode(vec![2_u8; 256]);
    write_config(&config_path, &db_path, "alice", &wrong_root);

    Command::new(assert_cmd::cargo::cargo_bin!("secbits"))
        .args([
            "--config",
            config_path.to_str().expect("config path"),
            "show",
            "mail/google/main",
        ])
        .assert()
        .failure()
        .stderr(contains("wrong root master key"));
}

#[test]
fn decrypt_commands_fail_if_user_not_found() {
    let (_dir, db_path, config_path) = setup_paths();

    let root = general_purpose::STANDARD.encode(vec![3_u8; 256]);
    write_config(&config_path, &db_path, "alice", &root);

    Command::new(assert_cmd::cargo::cargo_bin!("secbits"))
        .args([
            "--config",
            config_path.to_str().expect("config path"),
            "show",
            "mail/google/main",
        ])
        .assert()
        .failure()
        .stderr(contains("user not found"));
}
