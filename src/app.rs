use std::fs;
use std::io::{self, IsTerminal, Read, Write};

use base64::{engine::general_purpose, Engine as _};
use data_encoding::BASE32_NOPAD;
use hmac::{Hmac, Mac};
use rand::rngs::OsRng;
use rand::TryRngCore;
use regex::RegexBuilder;
use serde_json::Value;
use sha1::Sha1;
use tracing::{debug, error, info};
use zeroize::Zeroize;

use crate::cli::{BackupCommands, Cli, Commands};
use crate::compression::{compress, decompress};
use crate::config::AppConfig;
use crate::crypto::{
    create_user_master_key_blob, decrypt_bytes_from_blob, encrypt_bytes_to_blob,
    validate_root_master_key_b64, verify_user_master_key_blob, DOC_KEY_LEN,
};
use crate::db::{Database, EntryRecord};
use crate::error::AppError;
use crate::model::{
    append_snapshot, build_initial_history, now_timestamp, parse_history, parse_snapshot,
    restore_to_commit, serialize_history, EntrySnapshot,
};
use crate::Result;

type HmacSha1 = Hmac<Sha1>;

#[derive(Debug)]
struct AuthSession {
    user_id: i64,
    user_master_key: Vec<u8>,
}

impl Drop for AuthSession {
    fn drop(&mut self) {
        self.user_master_key.zeroize();
    }
}

pub fn dispatch(cli: Cli, config: AppConfig) -> Result<()> {
    log_command_invocation(&cli.command);

    let mut root_master_key = match validate_root_master_key_b64(&config.root_master_key_b64) {
        Ok(root_master_key) => root_master_key,
        Err(err) => {
            error!(error = %err, "failed to validate root master key from config");
            return Err(err);
        }
    };
    debug!("validated root master key format and length");

    let db = match Database::open(&config.db_path) {
        Ok(db) => db,
        Err(err) => {
            error!(error = %err, db_path = %config.db_path.display(), "failed to open database");
            root_master_key.zeroize();
            return Err(err);
        }
    };
    debug!(db_path = %config.db_path.display(), "opened database");

    let result = match &cli.command {
        Commands::Init { username } => {
            info!(username = %username, "handling init command");
            let result = handle_init(&db, &root_master_key, &config.username, username);
            if let Err(err) = &result {
                error!(error = %err, username = %username, "init command failed");
            }
            result
        }
        other => {
            debug!("authenticating session for command");
            let session = match authenticate_session(&db, &config.username, &root_master_key) {
                Ok(key) => key,
                Err(err) => {
                    error!(error = %err, username = %config.username, "session authentication failed");
                    root_master_key.zeroize();
                    return Err(err);
                }
            };
            debug!("session authenticated");
            dispatch_authenticated(&db, session, other)
        }
    };

    root_master_key.zeroize();
    result
}

fn dispatch_authenticated(
    db: &Database,
    mut session: AuthSession,
    command: &Commands,
) -> Result<()> {
    let result = match command {
        Commands::Ls { prefix } => handle_ls(db, session.user_id, prefix.as_deref()),
        Commands::Show { path } => handle_show(db, &session, path),
        Commands::Insert { path } => handle_insert(db, &session, path),
        Commands::Edit { path } => handle_edit(db, &session, path),
        Commands::Rm { path } => handle_rm(db, session.user_id, path),
        Commands::History { path } => handle_history(db, &session, path),
        Commands::Restore { path, commit } => handle_restore(db, &session, path, commit),
        Commands::Totp { path } => handle_totp(db, &session, path),
        Commands::Export { output } => handle_export(db, &session, output.as_ref()),
        Commands::Backup { command } => {
            let command_name = match command {
                BackupCommands::Push { .. } => "backup push",
                BackupCommands::Pull { .. } => "backup pull",
            };
            Err(AppError::CommandNotImplemented(command_name))
        }
        Commands::Init { .. } => Err(AppError::CommandNotImplemented("init")),
    };

    session.user_master_key.zeroize();
    result
}

fn handle_ls(db: &Database, user_id: i64, prefix: Option<&str>) -> Result<()> {
    let entries = db.list_entries_for_user(user_id)?;
    for entry in entries {
        if let Some(prefix) = prefix {
            if !entry.path_hint.starts_with(prefix) {
                continue;
            }
        }
        println!("{}", entry.path_hint);
    }
    Ok(())
}

fn handle_show(db: &Database, session: &AuthSession, path: &str) -> Result<()> {
    let entry = resolve_entry(db, session.user_id, path)?;
    let history = decrypt_history(session, &entry)?;
    let json = serde_json::to_string_pretty(&history.head_snapshot)
        .map_err(|_| AppError::HistoryCorrupted)?;
    println!("{}", json);
    Ok(())
}

fn handle_insert(db: &Database, session: &AuthSession, path: &str) -> Result<()> {
    validate_path_hint(path)?;
    if db.get_entry_by_path(session.user_id, path)?.is_some() {
        return Err(AppError::PathAlreadyExists);
    }

    let mut snapshot = read_snapshot_from_stdin()?;
    snapshot.timestamp = now_timestamp();

    let history = build_initial_history(snapshot)?;
    let history_json = serialize_history(&history)?;
    let compressed = compress(&history_json)?;

    let mut doc_key = [0_u8; DOC_KEY_LEN];
    OsRng
        .try_fill_bytes(&mut doc_key)
        .map_err(|_| AppError::KeyDerivationFailed)?;

    let entry_key = encrypt_bytes_to_blob(&session.user_master_key, &doc_key)?;
    let value = encrypt_bytes_to_blob(&doc_key, &compressed)?;

    db.create_entry(session.user_id, path, &entry_key, &value)?;
    doc_key.zeroize();

    info!(path = %path, "entry inserted");
    Ok(())
}

fn handle_edit(db: &Database, session: &AuthSession, path: &str) -> Result<()> {
    let entry = resolve_entry(db, session.user_id, path)?;
    let mut history = decrypt_history(session, &entry)?;

    let mut snapshot = read_snapshot_from_stdin()?;
    snapshot.timestamp = now_timestamp();

    let changed = append_snapshot(&mut history, snapshot)?;
    if !changed {
        println!("No changes detected");
        return Ok(());
    }

    update_entry_history(db, session, &entry, &history)?;
    info!(path = %entry.path_hint, "entry edited");
    Ok(())
}

fn handle_rm(db: &Database, user_id: i64, path: &str) -> Result<()> {
    let entry = resolve_entry(db, user_id, path)?;

    // §15.8: print resolved path and require explicit confirmation before deleting.
    print!("Delete `{}`? [y/N] ", entry.path_hint);
    io::stdout().flush().map_err(AppError::Io)?;

    let mut line = String::new();
    io::stdin()
        .read_line(&mut line)
        .map_err(AppError::Io)?;

    if line.trim().to_ascii_lowercase() != "y" {
        println!("Aborted.");
        return Ok(());
    }

    db.delete_entry_by_path(user_id, &entry.path_hint)?;
    println!("Deleted {}", entry.path_hint);
    Ok(())
}

fn handle_history(db: &Database, session: &AuthSession, path: &str) -> Result<()> {
    let entry = resolve_entry(db, session.user_id, path)?;
    let history = decrypt_history(session, &entry)?;

    for commit in history.commits {
        let parent = commit.parent.unwrap_or_else(|| "null".to_string());
        println!(
            "{} parent={} ts={} changed={}",
            commit.hash,
            parent,
            commit.timestamp,
            commit.changed.join(",")
        );
    }

    Ok(())
}

fn handle_restore(db: &Database, session: &AuthSession, path: &str, commit: &str) -> Result<()> {
    let entry = resolve_entry(db, session.user_id, path)?;
    let mut history = decrypt_history(session, &entry)?;

    let changed = restore_to_commit(&mut history, commit)?;
    if !changed {
        println!("Already at requested commit");
        return Ok(());
    }

    update_entry_history(db, session, &entry, &history)?;
    info!(path = %entry.path_hint, commit = %commit, "entry restored");
    Ok(())
}

fn handle_totp(db: &Database, session: &AuthSession, path: &str) -> Result<()> {
    let entry = resolve_entry(db, session.user_id, path)?;
    let history = decrypt_history(session, &entry)?;

    if history.head_snapshot.totp_secrets.is_empty() {
        return Err(AppError::NoTotpSecrets);
    }

    let now = chrono::Utc::now().timestamp();
    let step = 30_i64;
    let remaining = step - (now % step);

    for secret in &history.head_snapshot.totp_secrets {
        let code = compute_totp(secret, now)?;
        println!("{} ({}s)", code, remaining);
    }

    Ok(())
}

fn handle_export(
    db: &Database,
    session: &AuthSession,
    output: Option<&std::path::PathBuf>,
) -> Result<()> {
    let entries = db.list_entries_for_user(session.user_id)?;
    let mut out = Vec::new();

    for entry in entries {
        let history = decrypt_history(session, &entry)?;
        let entry_key_plain = decrypt_bytes_from_blob(&session.user_master_key, &entry.entry_key)
            .map_err(|_| AppError::InvalidEntryKeyBlob)?;
        let mut value =
            serde_json::to_value(&history.head_snapshot).map_err(|_| AppError::ExportFailed)?;
        if let Value::Object(map) = &mut value {
            map.insert("path".to_string(), Value::String(entry.path_hint));
            map.insert(
                "user_master_key".to_string(),
                Value::String(general_purpose::STANDARD.encode(&session.user_master_key)),
            );
            map.insert(
                "entry_key".to_string(),
                Value::String(general_purpose::STANDARD.encode(&entry_key_plain)),
            );
        }
        out.push(value);
    }

    let text = serde_json::to_string_pretty(&out).map_err(|_| AppError::ExportFailed)?;

    if let Some(path) = output {
        fs::write(path, text).map_err(|_| AppError::ExportFailed)?;
        println!("Warning: export output is plaintext secrets");
    } else {
        println!("{}", text);
        println!("Warning: export output is plaintext secrets");
    }

    Ok(())
}

fn update_entry_history(
    db: &Database,
    session: &AuthSession,
    entry: &EntryRecord,
    history: &crate::model::HistoryObject,
) -> Result<()> {
    let history_json = serialize_history(history)?;
    let compressed = compress(&history_json)?;

    let doc_key = decrypt_bytes_from_blob(&session.user_master_key, &entry.entry_key)
        .map_err(|_| AppError::InvalidEntryKeyBlob)?;
    let value_blob = encrypt_bytes_to_blob(&doc_key, &compressed)?;

    db.update_entry_value(entry.entry_id, &value_blob)?;

    Ok(())
}

fn decrypt_history(
    session: &AuthSession,
    entry: &EntryRecord,
) -> Result<crate::model::HistoryObject> {
    let doc_key = decrypt_bytes_from_blob(&session.user_master_key, &entry.entry_key)
        .map_err(|_| AppError::InvalidEntryKeyBlob)?;
    let compressed = decrypt_bytes_from_blob(&doc_key, &entry.value)?;
    let history_bytes = decompress(&compressed)?;
    parse_history(&history_bytes)
}

fn resolve_entry(db: &Database, user_id: i64, query: &str) -> Result<EntryRecord> {
    if let Some(entry) = db.get_entry_by_path(user_id, query)? {
        return Ok(entry);
    }

    let entries = db.list_entries_for_user(user_id)?;
    let paths: Vec<String> = entries.iter().map(|e| e.path_hint.clone()).collect();
    let matched = resolve_path_candidates(&paths, query);

    match matched.len() {
        0 => Err(AppError::PathNotFound),
        1 => db
            .get_entry_by_path(user_id, &matched[0])?
            .ok_or(AppError::PathNotFound),
        _ => {
            let shown: Vec<String> = matched.iter().take(20).cloned().collect();
            let suffix = if matched.len() > 20 {
                format!(" (showing 20 of {})", matched.len())
            } else {
                String::new()
            };
            Err(AppError::PathAmbiguous(format!(
                "{}{}",
                shown.join(", "),
                suffix
            )))
        }
    }
}

fn resolve_path_candidates(candidates: &[String], query: &str) -> Vec<String> {
    let case_sensitive = query.chars().any(|c| c.is_ascii_uppercase());

    let mut out = Vec::new();

    let regex = RegexBuilder::new(query)
        .case_insensitive(!case_sensitive)
        .build();

    match regex {
        Ok(re) => {
            for path in candidates {
                if re.is_match(path) {
                    out.push(path.clone());
                }
            }
        }
        Err(_) => {
            for path in candidates {
                let matched = if case_sensitive {
                    path.contains(query)
                } else {
                    path.to_ascii_lowercase()
                        .contains(&query.to_ascii_lowercase())
                };

                if matched {
                    out.push(path.clone());
                }
            }
        }
    }

    out.sort();
    out
}

fn validate_path_hint(path: &str) -> Result<()> {
    if path.is_empty()
        || path.starts_with('/')
        || path.ends_with('/')
        || path.contains("//")
        || path.len() > 512
    {
        return Err(AppError::InvalidPathHint);
    }

    if !path
        .chars()
        .all(|c| c == '/' || (c as u32 >= 0x20 && c as u32 <= 0x7e))
    {
        return Err(AppError::InvalidPathHint);
    }

    Ok(())
}

fn read_snapshot_from_stdin() -> Result<EntrySnapshot> {
    if io::stdin().is_terminal() {
        return read_snapshot_interactive();
    }

    let mut input = String::new();
    io::stdin()
        .read_to_string(&mut input)
        .map_err(|_| AppError::HistoryCorrupted)?;

    if input.trim().is_empty() {
        return Err(AppError::HistoryCorrupted);
    }

    parse_snapshot(input.as_bytes())
}

fn read_snapshot_interactive() -> Result<EntrySnapshot> {
    println!("Enter entry fields (leave blank for empty values).");

    let title = prompt("title")?;
    let username = prompt("username")?;
    let password = prompt("password")?;
    let notes = prompt("notes")?;
    let urls = parse_csv_list(&prompt("urls (comma-separated)")?);
    let totp_secrets = parse_csv_list(&prompt("totp secrets (comma-separated)")?);
    let tags = parse_csv_list(&prompt("tags (comma-separated)")?);

    Ok(EntrySnapshot {
        title,
        username,
        password,
        notes,
        urls,
        totp_secrets,
        custom_fields: Vec::new(),
        tags,
        timestamp: String::new(),
    })
}

fn prompt(label: &str) -> Result<String> {
    print!("{label}: ");
    io::stdout()
        .flush()
        .map_err(|_| AppError::HistoryCorrupted)?;

    let mut line = String::new();
    io::stdin()
        .read_line(&mut line)
        .map_err(|_| AppError::HistoryCorrupted)?;
    Ok(line.trim().to_string())
}

fn parse_csv_list(input: &str) -> Vec<String> {
    input
        .split(',')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect()
}

fn compute_totp(secret: &str, timestamp: i64) -> Result<String> {
    let secret_clean = secret.trim().replace(' ', "").to_ascii_uppercase();
    let secret_bytes = BASE32_NOPAD
        .decode(secret_clean.as_bytes())
        .map_err(|_| AppError::NoTotpSecrets)?;

    let counter = (timestamp / 30) as u64;
    let msg = counter.to_be_bytes();

    let mut mac = HmacSha1::new_from_slice(&secret_bytes).map_err(|_| AppError::NoTotpSecrets)?;
    mac.update(&msg);
    let hash = mac.finalize().into_bytes();

    let offset = (hash[19] & 0x0f) as usize;
    let binary = ((u32::from(hash[offset]) & 0x7f) << 24)
        | (u32::from(hash[offset + 1]) << 16)
        | (u32::from(hash[offset + 2]) << 8)
        | u32::from(hash[offset + 3]);

    Ok(format!("{:06}", binary % 1_000_000))
}

fn handle_init(
    db: &Database,
    root_master_key: &[u8],
    configured_username: &str,
    command_username: &str,
) -> Result<()> {
    if configured_username != command_username {
        error!(
            configured_username = %configured_username,
            command_username = %command_username,
            "init username does not match configured username"
        );
        return Err(AppError::InvalidConfigField(
            "init --username must match config username".to_string(),
        ));
    }

    if let Some(existing_user) = db.get_user_by_username(command_username)? {
        info!(username = %command_username, "existing user found, verifying stored key blob");
        let mut user_master_key =
            verify_user_master_key_blob(root_master_key, &existing_user.user_master_key)?;
        user_master_key.zeroize();
        info!(username = %command_username, "init verification succeeded");
        return Ok(());
    }

    let (mut user_master_key, user_master_key_blob) = create_user_master_key_blob(root_master_key)?;
    db.create_user(command_username, &user_master_key_blob)?;
    user_master_key.zeroize();
    info!(username = %command_username, "created new user and stored wrapped user master key");

    Ok(())
}

fn authenticate_session(
    db: &Database,
    username: &str,
    root_master_key: &[u8],
) -> Result<AuthSession> {
    let user = db.get_user_by_username(username)?.ok_or_else(|| {
        error!(username = %username, "configured user not found");
        AppError::UserNotFound
    })?;

    let user_master_key = match verify_user_master_key_blob(root_master_key, &user.user_master_key)
    {
        Ok(user_master_key) => user_master_key,
        Err(err) => {
            error!(error = %err, username = %username, "failed to verify user master key blob");
            return Err(err);
        }
    };
    debug!(username = %username, "verified user master key blob");

    Ok(AuthSession {
        user_id: user.user_id,
        user_master_key,
    })
}

#[cfg(test)]
mod tests {
    use super::compute_totp;

    // §16.1 #15: TOTP code generation with known secret and timestamp.
    // RFC 6238 Appendix B test vector (SHA-1, 30 s step):
    //   key  = "12345678901234567890" (ASCII 20 bytes)
    //   Base32(key) = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
    //   T = 59 s  =>  counter = floor(59/30) = 1
    //   8-digit TOTP = 94287082  =>  6-digit = 94287082 % 1_000_000 = 287082
    #[test]
    fn totp_known_secret_and_time_produce_expected_code() {
        let code = compute_totp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 59).expect("totp succeeds");
        assert_eq!(code, "287082");
    }

    // A zero-padded code must still be exactly 6 digits.
    #[test]
    fn totp_result_is_always_6_digits() {
        let code = compute_totp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 59).expect("totp");
        assert_eq!(code.len(), 6, "TOTP code must be exactly 6 characters");
        assert!(code.chars().all(|c| c.is_ascii_digit()), "TOTP code must be all digits");
    }
}

fn log_command_invocation(command: &Commands) {
    match command {
        Commands::Init { username } => {
            info!(command = "init", username = %username, "command invoked")
        }
        Commands::Ls { prefix } => info!(command = "ls", prefix = ?prefix, "command invoked"),
        Commands::Show { path } => info!(command = "show", path = %path, "command invoked"),
        Commands::Insert { path } => info!(command = "insert", path = %path, "command invoked"),
        Commands::Edit { path } => info!(command = "edit", path = %path, "command invoked"),
        Commands::Rm { path } => info!(command = "rm", path = %path, "command invoked"),
        Commands::History { path } => info!(command = "history", path = %path, "command invoked"),
        Commands::Restore { path, commit } => {
            info!(command = "restore", path = %path, commit = %commit, "command invoked")
        }
        Commands::Totp { path } => info!(command = "totp", path = %path, "command invoked"),
        Commands::Export { output } => {
            info!(command = "export", output = ?output, "command invoked")
        }
        Commands::Backup { command } => match command {
            BackupCommands::Push { target, all } => {
                info!(command = "backup push", target = ?target, all = *all, "command invoked")
            }
            BackupCommands::Pull { target, object } => {
                info!(command = "backup pull", target = %target, object = ?object, "command invoked")
            }
        },
    }
}
