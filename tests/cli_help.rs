use assert_cmd::Command;
use predicates::str::contains;

#[test]
fn help_includes_full_command_surface() {
    Command::new(assert_cmd::cargo::cargo_bin!("secbits"))
        .arg("--help")
        .assert()
        .success()
        .stdout(contains("init"))
        .stdout(contains("ls"))
        .stdout(contains("show"))
        .stdout(contains("insert"))
        .stdout(contains("edit"))
        .stdout(contains("rm"))
        .stdout(contains("history"))
        .stdout(contains("restore"))
        .stdout(contains("totp"))
        .stdout(contains("export"))
        .stdout(contains("backup"));
}

#[test]
fn backup_push_requires_target_or_all() {
    Command::new(assert_cmd::cargo::cargo_bin!("secbits"))
        .args(["backup", "push"])
        .assert()
        .failure()
        .stderr(contains("required"));
}
