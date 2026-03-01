use std::collections::BTreeMap;
use std::path::PathBuf;

use base64::{Engine as _, engine::general_purpose};
use chrono::Utc;
use rand::TryRngCore;
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

use crate::Result;
use crate::compression::{compress, decompress};
use crate::config::{AppConfig, default_config_path, load_config};
use crate::crypto::{DOC_KEY_LEN, USER_MASTER_KEY_LEN, decrypt_bytes_from_blob, encrypt_bytes_to_blob};
use crate::db;
use crate::error::AppError;
use crate::model::{
    EntrySnapshot, HistoryObject, append_snapshot, reconstruct_snapshot,
    restore_to_commit as model_restore_to_commit,
};
use crate::state::AppState;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EntryMeta {
    pub id: i64,
    #[serde(rename = "type")]
    pub entry_type: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    pub tags: Vec<String>,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TrashedEntryMeta {
    #[serde(flatten)]
    pub meta: EntryMeta,
    #[serde(rename = "deletedAt")]
    pub deleted_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EntryDetail {
    pub id: i64,
    #[serde(rename = "type")]
    pub entry_type: String,
    pub snapshot: EntrySnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CommitMeta {
    pub hash: String,
    pub parent: Option<String>,
    pub timestamp: String,
    pub changed: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TotpResult {
    pub code: String,
    #[serde(rename = "remainingSecs")]
    pub remaining_secs: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct VaultStats {
    #[serde(rename = "entryCount")]
    pub entry_count: usize,
    #[serde(rename = "trashCount")]
    pub trash_count: usize,
    #[serde(rename = "loginCount")]
    pub login_count: usize,
    #[serde(rename = "noteCount")]
    pub note_count: usize,
    #[serde(rename = "cardCount")]
    pub card_count: usize,
    #[serde(rename = "topTags")]
    pub top_tags: Vec<TagCount>,
    #[serde(rename = "totalCommits")]
    pub total_commits: usize,
    #[serde(rename = "avgCommitsPerEntry")]
    pub avg_commits_per_entry: f64,
    #[serde(rename = "withPassword")]
    pub with_password: usize,
    #[serde(rename = "withUsername")]
    pub with_username: usize,
    #[serde(rename = "withNotes")]
    pub with_notes: usize,
    #[serde(rename = "withUrls")]
    pub with_urls: usize,
    #[serde(rename = "totalUrls")]
    pub total_urls: usize,
    #[serde(rename = "withTotp")]
    pub with_totp: usize,
    #[serde(rename = "totalTotp")]
    pub total_totp: usize,
    #[serde(rename = "withCustomFields")]
    pub with_custom_fields: usize,
    #[serde(rename = "totalCustomFields")]
    pub total_custom_fields: usize,
    #[serde(rename = "withTags")]
    pub with_tags: usize,
    #[serde(rename = "maxCommits")]
    pub max_commits: usize,
    #[serde(rename = "neverEdited")]
    pub never_edited: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TagCount {
    pub tag: String,
    pub count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SetupInfo {
    #[serde(rename = "defaultConfigPath")]
    pub default_config_path: String,
    #[serde(rename = "defaultConfigExists")]
    pub default_config_exists: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct ExportPayload {
    version: u32,
    username: String,
    data: Vec<ExportEntry>,
    trash: Vec<ExportTrashEntry>,
}

pub fn get_setup_info() -> Result<SetupInfo> {
    let path = default_config_path()?;
    Ok(SetupInfo {
        default_config_path: path.display().to_string(),
        default_config_exists: path.is_file(),
    })
}

pub fn select_config_path(state: &AppState, path: String) -> Result<()> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(AppError::ConfigNotFound);
    }

    let next_config = load_config(Some(PathBuf::from(trimmed)))?;
    let next_conn = db::open_connection(&next_config.db_path)?;
    db::create_schema(&next_conn)?;

    {
        let mut conn = state
            .conn
            .lock()
            .map_err(|_| AppError::Other("database mutex poisoned".to_string()))?;
        *conn = next_conn;
    }

    {
        let mut session = state
            .session
            .lock()
            .map_err(|_| AppError::Other("session mutex poisoned".to_string()))?;
        session.clear();
    }

    {
        let mut config = state
            .config
            .lock()
            .map_err(|_| AppError::Other("config mutex poisoned".to_string()))?;
        *config = next_config;
    }

    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct ExportEntry {
    id: i64,
    #[serde(rename = "type")]
    entry_type: String,
    #[serde(flatten)]
    snapshot: EntrySnapshot,
    #[serde(rename = "_commits")]
    commits: Vec<CommitMeta>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct ExportTrashEntry {
    #[serde(flatten)]
    entry: ExportEntry,
    #[serde(rename = "deletedAt")]
    deleted_at: String,
}

pub fn init_vault(state: &AppState, username: String) -> Result<()> {
    let config = current_config(state)?;
    let conn = state
        .conn
        .lock()
        .map_err(|_| AppError::Other("database mutex poisoned".to_string()))?;

    db::create_schema(&conn)?;

    if db::get_vault_info(&conn, "username")?.is_some() || db::get_umk_blob(&conn)?.is_some() {
        return Err(AppError::DatabaseAlreadyInitialized);
    }

    let now = now_iso();
    db::set_vault_info(&conn, "username", &username)?;
    db::set_vault_info(&conn, "created_at", &now)?;
    db::set_vault_info(&conn, "schema_version", "1")?;

    let mut user_master_key = vec![0_u8; USER_MASTER_KEY_LEN];
    OsRng
        .try_fill_bytes(&mut user_master_key)
        .map_err(|_| AppError::KeyDerivationFailed)?;

    let umk_blob = encrypt_bytes_to_blob(&config.root_master_key, &user_master_key)?;
    db::set_umk_blob(&conn, &umk_blob, &now)?;
    user_master_key.zeroize();

    Ok(())
}

pub fn is_initialized(state: &AppState) -> Result<bool> {
    let conn = state
        .conn
        .lock()
        .map_err(|_| AppError::Other("database mutex poisoned".to_string()))?;
    db::create_schema(&conn)?;

    let username = db::get_vault_info(&conn, "username")?;
    let umk = db::get_umk_blob(&conn)?;

    Ok(username.is_some() && umk.is_some())
}

pub fn unlock_vault(state: &AppState) -> Result<()> {
    let config = current_config(state)?;
    let conn = state
        .conn
        .lock()
        .map_err(|_| AppError::Other("database mutex poisoned".to_string()))?;
    db::create_schema(&conn)?;

    let username = db::get_vault_info(&conn, "username")?.ok_or(AppError::UserNotFound)?;
    if username != config.username {
        return Err(AppError::UserNotFound);
    }

    let umk_blob = db::get_umk_blob(&conn)?.ok_or(AppError::UserNotFound)?;

    let user_master_key = match decrypt_bytes_from_blob(&config.root_master_key, &umk_blob) {
        Ok(key) => key,
        Err(AppError::DecryptionFailedAuthentication) => return Err(AppError::WrongRootMasterKey),
        Err(err) => return Err(err),
    };

    if user_master_key.len() != USER_MASTER_KEY_LEN {
        return Err(AppError::WrongRootMasterKey);
    }

    let mut session = state
        .session
        .lock()
        .map_err(|_| AppError::Other("session mutex poisoned".to_string()))?;
    session.set_user_master_key(user_master_key);

    Ok(())
}

pub fn lock_vault(state: &AppState) -> Result<()> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| AppError::Other("session mutex poisoned".to_string()))?;
    session.clear();
    Ok(())
}

pub fn create_entry(state: &AppState, entry_type: String, mut snapshot: EntrySnapshot) -> Result<EntryMeta> {
    let umk = require_unlocked_umk(state)?;
    let conn = state
        .conn
        .lock()
        .map_err(|_| AppError::Other("database mutex poisoned".to_string()))?;

    snapshot.timestamp = now_iso();
    let history = HistoryObject::new(entry_type, snapshot);

    let mut doc_key = vec![0_u8; DOC_KEY_LEN];
    OsRng
        .try_fill_bytes(&mut doc_key)
        .map_err(|_| AppError::KeyDerivationFailed)?;

    let entry_key_blob = encrypt_bytes_to_blob(&umk, &doc_key)?;
    let value_blob = encrypt_history(&doc_key, &history)?;

    let id = db::insert_entry(&conn, &entry_key_blob, &value_blob)?;
    doc_key.zeroize();

    Ok(history_to_meta(id, &history))
}

pub fn get_entry(state: &AppState, id: i64) -> Result<EntryDetail> {
    let umk = require_unlocked_umk(state)?;
    let conn = state
        .conn
        .lock()
        .map_err(|_| AppError::Other("database mutex poisoned".to_string()))?;

    let row = db::get_active_entry(&conn, id)?.ok_or(AppError::EntryNotFound)?;
    let history = decrypt_history(&umk, &row.entry_key, &row.value)?;

    Ok(EntryDetail {
        id,
        entry_type: history.entry_type,
        snapshot: history.head_snapshot,
    })
}

pub fn update_entry(state: &AppState, id: i64, mut snapshot: EntrySnapshot) -> Result<EntryMeta> {
    let umk = require_unlocked_umk(state)?;
    let conn = state
        .conn
        .lock()
        .map_err(|_| AppError::Other("database mutex poisoned".to_string()))?;

    let row = db::get_active_entry(&conn, id)?.ok_or(AppError::EntryNotFound)?;
    let mut history = decrypt_history(&umk, &row.entry_key, &row.value)?;

    snapshot.timestamp = now_iso();
    let appended = append_snapshot(&mut history, snapshot)?;
    if !appended {
        return Ok(history_to_meta(id, &history));
    }

    let mut doc_key = decrypt_bytes_from_blob(&umk, &row.entry_key)?;
    let value_blob = encrypt_history(&doc_key, &history)?;
    doc_key.zeroize();

    db::update_entry(&conn, id, &row.entry_key, &value_blob)?;

    Ok(history_to_meta(id, &history))
}

pub fn delete_entry(state: &AppState, id: i64) -> Result<()> {
    let _umk = require_unlocked_umk(state)?;
    let conn = state
        .conn
        .lock()
        .map_err(|_| AppError::Other("database mutex poisoned".to_string()))?;

    if db::get_active_entry(&conn, id)?.is_none() {
        return Err(AppError::EntryNotFound);
    }

    db::set_entry_deleted(&conn, id, &now_iso())?;
    Ok(())
}

pub fn list_entries(state: &AppState, filter: Option<String>) -> Result<Vec<EntryMeta>> {
    let umk = require_unlocked_umk(state)?;
    let conn = state
        .conn
        .lock()
        .map_err(|_| AppError::Other("database mutex poisoned".to_string()))?;

    let rows = db::list_active_entries(&conn)?;
    let mut out = Vec::new();

    for row in rows {
        let history = decrypt_history(&umk, &row.entry_key, &row.value)?;
        let meta = history_to_meta(row.entry_id, &history);
        if matches_filter(&history.head_snapshot, filter.as_deref()) {
            out.push(meta);
        }
    }

    Ok(out)
}

pub fn list_trash(state: &AppState) -> Result<Vec<TrashedEntryMeta>> {
    let umk = require_unlocked_umk(state)?;
    let conn = state
        .conn
        .lock()
        .map_err(|_| AppError::Other("database mutex poisoned".to_string()))?;

    let rows = db::list_trashed_entries(&conn)?;
    let mut out = Vec::new();

    for row in rows {
        let history = decrypt_history(&umk, &row.entry.entry_key, &row.entry.value)?;
        out.push(TrashedEntryMeta {
            meta: history_to_meta(row.entry.entry_id, &history),
            deleted_at: row.deleted_at,
        });
    }

    Ok(out)
}

pub fn get_trash_entry(state: &AppState, id: i64) -> Result<EntryDetail> {
    let umk = require_unlocked_umk(state)?;
    let conn = state
        .conn
        .lock()
        .map_err(|_| AppError::Other("database mutex poisoned".to_string()))?;

    let row = db::get_trashed_entry(&conn, id)?.ok_or(AppError::EntryNotFound)?;
    let history = decrypt_history(&umk, &row.entry.entry_key, &row.entry.value)?;

    Ok(EntryDetail {
        id,
        entry_type: history.entry_type,
        snapshot: history.head_snapshot,
    })
}

pub fn restore_entry(state: &AppState, id: i64) -> Result<EntryMeta> {
    let umk = require_unlocked_umk(state)?;
    let conn = state
        .conn
        .lock()
        .map_err(|_| AppError::Other("database mutex poisoned".to_string()))?;

    let row = db::get_trashed_entry(&conn, id)?.ok_or(AppError::EntryNotFound)?;
    db::clear_entry_deleted(&conn, id)?;

    let history = decrypt_history(&umk, &row.entry.entry_key, &row.entry.value)?;
    Ok(history_to_meta(id, &history))
}

pub fn purge_entry(state: &AppState, id: i64) -> Result<()> {
    let _umk = require_unlocked_umk(state)?;
    let conn = state
        .conn
        .lock()
        .map_err(|_| AppError::Other("database mutex poisoned".to_string()))?;

    if !db::is_entry_trashed(&conn, id)? {
        return Err(AppError::EntryNotFound);
    }

    db::clear_entry_deleted(&conn, id)?;
    db::delete_entry(&conn, id)?;
    Ok(())
}

pub fn restore_to_commit(state: &AppState, id: i64, hash: String) -> Result<EntryMeta> {
    let umk = require_unlocked_umk(state)?;
    let conn = state
        .conn
        .lock()
        .map_err(|_| AppError::Other("database mutex poisoned".to_string()))?;

    let row = db::get_active_entry(&conn, id)?.ok_or(AppError::EntryNotFound)?;
    let mut history = decrypt_history(&umk, &row.entry_key, &row.value)?;

    let restored = model_restore_to_commit(&mut history, &hash, now_iso())?;
    if restored {
        let mut doc_key = decrypt_bytes_from_blob(&umk, &row.entry_key)?;
        let value_blob = encrypt_history(&doc_key, &history)?;
        doc_key.zeroize();
        db::update_entry(&conn, id, &row.entry_key, &value_blob)?;
    }

    Ok(history_to_meta(id, &history))
}

pub fn get_history(state: &AppState, id: i64) -> Result<Vec<CommitMeta>> {
    let umk = require_unlocked_umk(state)?;
    let conn = state
        .conn
        .lock()
        .map_err(|_| AppError::Other("database mutex poisoned".to_string()))?;

    // History should be available for both active and trashed entries.
    let row = db::get_entry(&conn, id)?.ok_or(AppError::EntryNotFound)?;
    let history = decrypt_history(&umk, &row.entry_key, &row.value)?;

    Ok(history.commits.into_iter().map(commit_to_meta).collect())
}

pub fn get_commit_snapshot(state: &AppState, id: i64, hash: String) -> Result<EntrySnapshot> {
    let umk = require_unlocked_umk(state)?;
    let conn = state
        .conn
        .lock()
        .map_err(|_| AppError::Other("database mutex poisoned".to_string()))?;

    // Commit snapshots should be available for both active and trashed entries.
    let row = db::get_entry(&conn, id)?.ok_or(AppError::EntryNotFound)?;
    let history = decrypt_history(&umk, &row.entry_key, &row.value)?;
    reconstruct_snapshot(&history, &hash)
}

pub fn get_totp(state: &AppState, id: i64) -> Result<Vec<TotpResult>> {
    let umk = require_unlocked_umk(state)?;
    let conn = state
        .conn
        .lock()
        .map_err(|_| AppError::Other("database mutex poisoned".to_string()))?;

    let row = db::get_active_entry(&conn, id)?.ok_or(AppError::EntryNotFound)?;
    let history = decrypt_history(&umk, &row.entry_key, &row.value)?;
    get_totp_from_snapshot_at_timestamp(&history.head_snapshot, Utc::now().timestamp())
}

pub fn export_vault(state: &AppState) -> Result<String> {
    let config = current_config(state)?;
    let umk = require_unlocked_umk(state)?;
    let conn = state
        .conn
        .lock()
        .map_err(|_| AppError::Other("database mutex poisoned".to_string()))?;

    let active_rows = db::list_active_entries(&conn)?;
    let mut data = Vec::with_capacity(active_rows.len());
    for row in active_rows {
        let history = decrypt_history(&umk, &row.entry_key, &row.value)?;
        data.push(ExportEntry {
            id: row.entry_id,
            entry_type: history.entry_type.clone(),
            snapshot: history.head_snapshot,
            commits: history.commits.into_iter().map(commit_to_meta).collect(),
        });
    }

    let trashed_rows = db::list_trashed_entries(&conn)?;
    let mut trash = Vec::with_capacity(trashed_rows.len());
    for row in trashed_rows {
        let history = decrypt_history(&umk, &row.entry.entry_key, &row.entry.value)?;
        trash.push(ExportTrashEntry {
            entry: ExportEntry {
                id: row.entry.entry_id,
                entry_type: history.entry_type.clone(),
                snapshot: history.head_snapshot,
                commits: history.commits.into_iter().map(commit_to_meta).collect(),
            },
            deleted_at: row.deleted_at,
        });
    }

    let payload = ExportPayload {
        version: 1,
        username: config.username,
        data,
        trash,
    };

    serde_json::to_string_pretty(&payload)
        .map_err(|err| AppError::Other(format!("export serialization failed: {err}")))
}

pub fn rotate_master_key(state: &AppState, new_key_b64: String) -> Result<()> {
    let current_root_key = {
        let config = state
            .config
            .lock()
            .map_err(|_| AppError::Other("config mutex poisoned".to_string()))?;
        config.root_master_key.clone()
    };
    let new_root_key =
        crate::config::decode_root_master_key(new_key_b64.trim()).map_err(|_| AppError::InvalidRootMasterKey)?;

    let conn = state
        .conn
        .lock()
        .map_err(|_| AppError::Other("database mutex poisoned".to_string()))?;

    let umk_blob = db::get_umk_blob(&conn)?.ok_or(AppError::UserNotFound)?;
    let mut umk = match decrypt_bytes_from_blob(&current_root_key, &umk_blob) {
        Ok(v) => v,
        Err(AppError::DecryptionFailedAuthentication) => return Err(AppError::WrongRootMasterKey),
        Err(err) => return Err(err),
    };
    let rotated_blob = encrypt_bytes_to_blob(&new_root_key, &umk)?;
    umk.zeroize();

    db::set_umk_blob(&conn, &rotated_blob, &now_iso())?;
    drop(conn);

    let mut config = state
        .config
        .lock()
        .map_err(|_| AppError::Other("config mutex poisoned".to_string()))?;
    config.root_master_key = new_root_key;
    Ok(())
}

pub fn generate_root_master_key() -> Result<String> {
    let mut bytes = vec![0u8; 256];
    OsRng
        .try_fill_bytes(&mut bytes)
        .map_err(|err| AppError::Other(format!("failed to generate random bytes: {err}")))?;
    Ok(general_purpose::STANDARD.encode(&bytes))
}

pub fn get_vault_stats(state: &AppState) -> Result<VaultStats> {
    let umk = require_unlocked_umk(state)?;
    let conn = state
        .conn
        .lock()
        .map_err(|_| AppError::Other("database mutex poisoned".to_string()))?;

    let active_rows = db::list_active_entries(&conn)?;
    let trashed_rows = db::list_trashed_entries(&conn)?;

    let mut login_count = 0_usize;
    let mut note_count = 0_usize;
    let mut card_count = 0_usize;
    let mut total_commits = 0_usize;
    let mut with_password = 0_usize;
    let mut with_username = 0_usize;
    let mut with_notes = 0_usize;
    let mut with_urls = 0_usize;
    let mut total_urls = 0_usize;
    let mut with_totp = 0_usize;
    let mut total_totp = 0_usize;
    let mut with_custom_fields = 0_usize;
    let mut total_custom_fields = 0_usize;
    let mut with_tags = 0_usize;
    let mut max_commits = 0_usize;
    let mut never_edited = 0_usize;
    let mut tag_counts: BTreeMap<String, usize> = BTreeMap::new();

    for row in &active_rows {
        let history = decrypt_history(&umk, &row.entry_key, &row.value)?;
        match history.entry_type.as_str() {
            "login" => login_count += 1,
            "note" => note_count += 1,
            "card" => card_count += 1,
            _ => {}
        }
        let commit_count = history.commits.len();
        total_commits += commit_count;
        if commit_count > max_commits {
            max_commits = commit_count;
        }
        if commit_count <= 1 {
            never_edited += 1;
        }
        let snap = &history.head_snapshot;
        if !snap.password.is_empty() { with_password += 1; }
        if !snap.username.is_empty() { with_username += 1; }
        if !snap.notes.is_empty() { with_notes += 1; }
        if !snap.urls.is_empty() { with_urls += 1; total_urls += snap.urls.len(); }
        if !snap.totp_secrets.is_empty() { with_totp += 1; total_totp += snap.totp_secrets.len(); }
        if !snap.custom_fields.is_empty() { with_custom_fields += 1; total_custom_fields += snap.custom_fields.len(); }
        if snap.tags.iter().any(|t| !t.trim().is_empty()) { with_tags += 1; }
        for tag in &snap.tags {
            if tag.trim().is_empty() {
                continue;
            }
            *tag_counts.entry(tag.to_ascii_lowercase()).or_insert(0) += 1;
        }
    }

    let mut top_tags = tag_counts
        .into_iter()
        .map(|(tag, count)| TagCount { tag, count })
        .collect::<Vec<_>>();
    top_tags.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.tag.cmp(&b.tag)));
    top_tags.truncate(5);

    let entry_count = active_rows.len();
    let avg_commits_per_entry = if entry_count == 0 {
        0.0
    } else {
        total_commits as f64 / entry_count as f64
    };

    Ok(VaultStats {
        entry_count,
        trash_count: trashed_rows.len(),
        login_count,
        note_count,
        card_count,
        top_tags,
        total_commits,
        avg_commits_per_entry,
        with_password,
        with_username,
        with_notes,
        with_urls,
        total_urls,
        with_totp,
        total_totp,
        with_custom_fields,
        total_custom_fields,
        with_tags,
        max_commits,
        never_edited,
    })
}

fn require_unlocked_umk(state: &AppState) -> Result<Vec<u8>> {
    let session = state
        .session
        .lock()
        .map_err(|_| AppError::Other("session mutex poisoned".to_string()))?;
    session.user_master_key().ok_or(AppError::SessionLocked)
}

fn current_config(state: &AppState) -> Result<AppConfig> {
    let config = state
        .config
        .lock()
        .map_err(|_| AppError::Other("config mutex poisoned".to_string()))?;
    Ok(config.clone())
}

fn encrypt_history(doc_key: &[u8], history: &HistoryObject) -> Result<Vec<u8>> {
    let serialized = serde_json::to_vec(history)
        .map_err(|err| AppError::Other(format!("history serialization failed: {err}")))?;
    let compressed = compress(&serialized)?;
    encrypt_bytes_to_blob(doc_key, &compressed)
}

fn decrypt_history(umk: &[u8], entry_key_blob: &[u8], value_blob: &[u8]) -> Result<HistoryObject> {
    let mut doc_key = decrypt_bytes_from_blob(umk, entry_key_blob)?;
    let mut compressed = decrypt_bytes_from_blob(&doc_key, value_blob)?;
    let mut json = decompress(&compressed)?;

    let history: HistoryObject = serde_json::from_slice(&json)
        .map_err(|err| AppError::Other(format!("history parse failed: {err}")))?;

    doc_key.zeroize();
    compressed.zeroize();
    json.zeroize();

    Ok(history)
}

fn history_to_meta(id: i64, history: &HistoryObject) -> EntryMeta {
    EntryMeta {
        id,
        entry_type: history.entry_type.clone(),
        title: history.head_snapshot.title.clone(),
        username: if history.head_snapshot.username.is_empty() {
            None
        } else {
            Some(history.head_snapshot.username.clone())
        },
        tags: history.head_snapshot.tags.clone(),
        updated_at: history.head_snapshot.timestamp.clone(),
    }
}

fn commit_to_meta(commit: crate::model::HistoryCommit) -> CommitMeta {
    CommitMeta {
        hash: commit.hash,
        parent: commit.parent,
        timestamp: commit.timestamp,
        changed: commit.changed,
    }
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn matches_filter(snapshot: &EntrySnapshot, filter: Option<&str>) -> bool {
    let Some(raw) = filter else {
        return true;
    };

    let normalized = raw.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return true;
    }

    if let Some(tag) = normalized.strip_prefix("tag:") {
        return snapshot.tags.iter().any(|t| t.eq_ignore_ascii_case(tag));
    }

    let in_title = snapshot.title.to_ascii_lowercase().contains(&normalized);
    let in_username = snapshot.username.to_ascii_lowercase().contains(&normalized);
    let in_urls = snapshot
        .urls
        .iter()
        .any(|url| url.to_ascii_lowercase().contains(&normalized));

    in_title || in_username || in_urls
}

fn get_totp_from_snapshot_at_timestamp(
    snapshot: &EntrySnapshot,
    unix_timestamp: i64,
) -> Result<Vec<TotpResult>> {
    if snapshot.totp_secrets.is_empty() {
        return Err(AppError::NoTotpSecret);
    }

    let timestamp = unix_timestamp.max(0) as u64;
    let counter = timestamp / 30;
    let rem = 30 - (timestamp % 30);
    let remaining_secs = if rem == 0 { 30 } else { rem as u32 };

    let mut out = Vec::new();
    for secret in &snapshot.totp_secrets {
        if let Some(code) = generate_totp(secret, counter) {
            out.push(TotpResult {
                code,
                remaining_secs,
            });
        }
    }

    if out.is_empty() {
        return Err(AppError::NoTotpSecret);
    }

    Ok(out)
}

fn generate_totp(secret: &str, counter: u64) -> Option<String> {
    let key = base32_decode(secret)?;
    if key.is_empty() {
        return None;
    }

    let mut counter_bytes = [0_u8; 8];
    counter_bytes.copy_from_slice(&counter.to_be_bytes());
    let mac = hmac_sha1(&key, &counter_bytes);

    let offset = (mac[19] & 0x0f) as usize;
    let code = ((u32::from(mac[offset]) & 0x7f) << 24)
        | (u32::from(mac[offset + 1]) << 16)
        | (u32::from(mac[offset + 2]) << 8)
        | u32::from(mac[offset + 3]);

    Some(format!("{:06}", code % 1_000_000))
}

fn base32_decode(input: &str) -> Option<Vec<u8>> {
    let mut bits: u16 = 0;
    let mut bit_len: u8 = 0;
    let mut out = Vec::new();

    for ch in input.chars() {
        let value = match ch {
            'A'..='Z' => ch as u8 - b'A',
            'a'..='z' => ch as u8 - b'a',
            '2'..='7' => ch as u8 - b'2' + 26,
            ' ' | '\t' | '\n' | '\r' | '=' | '_' | '-' => continue,
            _ => return None,
        };

        bits = (bits << 5) | u16::from(value);
        bit_len += 5;

        while bit_len >= 8 {
            bit_len -= 8;
            out.push(((bits >> bit_len) & 0xff) as u8);
            bits &= (1 << bit_len) - 1;
        }
    }

    Some(out)
}

fn hmac_sha1(key: &[u8], message: &[u8]) -> [u8; 20] {
    const BLOCK_SIZE: usize = 64;
    let mut key_block = [0_u8; BLOCK_SIZE];

    if key.len() > BLOCK_SIZE {
        let hashed = sha1_digest(key);
        key_block[..hashed.len()].copy_from_slice(&hashed);
    } else {
        key_block[..key.len()].copy_from_slice(key);
    }

    let mut ipad = [0_u8; BLOCK_SIZE];
    let mut opad = [0_u8; BLOCK_SIZE];
    for idx in 0..BLOCK_SIZE {
        ipad[idx] = key_block[idx] ^ 0x36;
        opad[idx] = key_block[idx] ^ 0x5c;
    }

    let mut inner = Vec::with_capacity(BLOCK_SIZE + message.len());
    inner.extend_from_slice(&ipad);
    inner.extend_from_slice(message);
    let inner_hash = sha1_digest(&inner);

    let mut outer = Vec::with_capacity(BLOCK_SIZE + inner_hash.len());
    outer.extend_from_slice(&opad);
    outer.extend_from_slice(&inner_hash);
    sha1_digest(&outer)
}

fn sha1_digest(data: &[u8]) -> [u8; 20] {
    let mut h0: u32 = 0x67452301;
    let mut h1: u32 = 0xEFCDAB89;
    let mut h2: u32 = 0x98BADCFE;
    let mut h3: u32 = 0x10325476;
    let mut h4: u32 = 0xC3D2E1F0;

    let bit_len = (data.len() as u64) * 8;
    let mut padded = data.to_vec();
    padded.push(0x80);
    while (padded.len() % 64) != 56 {
        padded.push(0);
    }
    padded.extend_from_slice(&bit_len.to_be_bytes());

    for chunk in padded.chunks_exact(64) {
        let mut w = [0_u32; 80];
        for (i, word) in w.iter_mut().take(16).enumerate() {
            let start = i * 4;
            *word = u32::from_be_bytes([
                chunk[start],
                chunk[start + 1],
                chunk[start + 2],
                chunk[start + 3],
            ]);
        }

        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }

        let mut a = h0;
        let mut b = h1;
        let mut c = h2;
        let mut d = h3;
        let mut e = h4;

        for (i, word) in w.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => (((b & c) | ((!b) & d)), 0x5A827999),
                20..=39 => (b ^ c ^ d, 0x6ED9EBA1),
                40..=59 => (((b & c) | (b & d) | (c & d)), 0x8F1BBCDC),
                _ => (b ^ c ^ d, 0xCA62C1D6),
            };
            let temp = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(*word);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = temp;
        }

        h0 = h0.wrapping_add(a);
        h1 = h1.wrapping_add(b);
        h2 = h2.wrapping_add(c);
        h3 = h3.wrapping_add(d);
        h4 = h4.wrapping_add(e);
    }

    let mut out = [0_u8; 20];
    out[..4].copy_from_slice(&h0.to_be_bytes());
    out[4..8].copy_from_slice(&h1.to_be_bytes());
    out[8..12].copy_from_slice(&h2.to_be_bytes());
    out[12..16].copy_from_slice(&h3.to_be_bytes());
    out[16..20].copy_from_slice(&h4.to_be_bytes());
    out
}

#[cfg(test)]
mod tests {
    use base64::{Engine as _, engine::general_purpose};
    use tempfile::tempdir;

    use super::{
        create_entry, delete_entry, export_vault, get_commit_snapshot, get_entry, get_history, get_totp,
        get_totp_from_snapshot_at_timestamp, get_trash_entry, get_vault_stats, init_vault,
        is_initialized, list_entries, list_trash, lock_vault, purge_entry, restore_entry,
        restore_to_commit, rotate_master_key, unlock_vault, update_entry,
    };
    use crate::config::AppConfig;
    use crate::db::open_connection;
    use crate::error::AppError;
    use crate::model::EntrySnapshot;
    use crate::state::AppState;

    fn new_state(root_key: Vec<u8>, username: &str) -> AppState {
        let dir = tempdir().expect("tempdir");
        let db_path = dir.path().join("vault.db");
        let conn = open_connection(&db_path).expect("open db");
        crate::db::create_schema(&conn).expect("create schema");

        let _leaked = Box::leak(Box::new(dir));

        AppState::new(
            conn,
            AppConfig {
                root_master_key: root_key,
                db_path,
                username: username.to_string(),
                backup_on_save: false,
                log_level: "warn".to_string(),
                targets: Default::default(),
            },
        )
    }

    fn login_snapshot(title: &str, username: &str, password: &str) -> EntrySnapshot {
        EntrySnapshot {
            title: title.to_string(),
            username: username.to_string(),
            password: password.to_string(),
            urls: vec!["https://mail.example.com".to_string()],
            tags: vec!["email".to_string()],
            ..EntrySnapshot::default()
        }
    }

    #[test]
    fn session_lifecycle_init_unlock_lock_reunlock() {
        let root_key = vec![11_u8; 256];
        let state = new_state(root_key, "alice");

        assert!(!is_initialized(&state).expect("query init"));
        init_vault(&state, "alice".to_string()).expect("init vault");
        assert!(is_initialized(&state).expect("query init"));

        unlock_vault(&state).expect("unlock");
        assert!(state.session.lock().expect("session").is_unlocked());

        lock_vault(&state).expect("lock");
        assert!(!state.session.lock().expect("session").is_unlocked());

        unlock_vault(&state).expect("unlock again");
        assert!(state.session.lock().expect("session").is_unlocked());
    }

    #[test]
    fn unlock_with_wrong_root_key_fails() {
        let state = new_state(vec![5_u8; 256], "alice");
        init_vault(&state, "alice".to_string()).expect("init vault");

        {
            let mut session = state.session.lock().expect("session");
            session.clear();
        }

        let wrong_root = vec![9_u8; 256];
        let state_config = state.config.lock().expect("config").clone();
        let wrong_state = AppState::new(
            open_connection(&state_config.db_path).expect("open shared db"),
            AppConfig {
                root_master_key: wrong_root,
                db_path: state_config.db_path.clone(),
                username: "alice".to_string(),
                backup_on_save: false,
                log_level: "warn".to_string(),
                targets: Default::default(),
            },
        );

        let err = unlock_vault(&wrong_state).expect_err("must fail");
        assert!(matches!(err, AppError::WrongRootMasterKey));
    }

    #[test]
    fn entry_crud_and_trash_lifecycle() {
        let state = new_state(vec![3_u8; 256], "alice");
        init_vault(&state, "alice".to_string()).expect("init");
        unlock_vault(&state).expect("unlock");

        let created = create_entry(
            &state,
            "login".to_string(),
            login_snapshot("Gmail", "alice", "one"),
        )
        .expect("create");
        assert_eq!(created.entry_type, "login");

        let detail = get_entry(&state, created.id).expect("get");
        assert_eq!(detail.snapshot.password, "one");

        let updated = update_entry(
            &state,
            created.id,
            login_snapshot("Gmail", "alice", "two"),
        )
        .expect("update");
        assert_eq!(updated.id, created.id);

        let dedup = update_entry(
            &state,
            created.id,
            login_snapshot("Gmail", "alice", "two"),
        )
        .expect("update dedup");
        assert_eq!(dedup.id, created.id);

        let listed = list_entries(&state, Some("gmail".to_string())).expect("list");
        assert_eq!(listed.len(), 1);

        let tag_listed = list_entries(&state, Some("tag:email".to_string())).expect("list tag");
        assert_eq!(tag_listed.len(), 1);

        let before_restore = get_entry(&state, created.id).expect("before restore");
        let current_hash = {
            let conn = state.conn.lock().expect("lock conn");
            let row = crate::db::get_active_entry(&conn, created.id)
                .expect("db read")
                .expect("row");
            let session_key = state
                .session
                .lock()
                .expect("session")
                .user_master_key()
                .expect("umk");
            let history = super::decrypt_history(&session_key, &row.entry_key, &row.value)
                .expect("history");
            history.commits[1].hash.clone()
        };

        let restored_meta = restore_to_commit(&state, created.id, current_hash).expect("restore commit");
        assert_eq!(restored_meta.id, created.id);
        let after_restore = get_entry(&state, created.id).expect("after restore");
        assert_ne!(before_restore.snapshot.password, after_restore.snapshot.password);

        delete_entry(&state, created.id).expect("delete");
        assert!(get_entry(&state, created.id).is_err());

        let trash = list_trash(&state).expect("list trash");
        assert_eq!(trash.len(), 1);

        let trash_detail = get_trash_entry(&state, created.id).expect("trash detail");
        assert_eq!(trash_detail.snapshot.title, "Gmail");

        restore_entry(&state, created.id).expect("restore entry");
        assert!(get_entry(&state, created.id).is_ok());

        delete_entry(&state, created.id).expect("delete again");
        purge_entry(&state, created.id).expect("purge");
        let err = get_entry(&state, created.id).expect_err("must be gone");
        assert!(matches!(err, AppError::EntryNotFound));
    }

    #[test]
    fn history_commands_return_expected_data() {
        let state = new_state(vec![7_u8; 256], "alice");
        init_vault(&state, "alice".to_string()).expect("init");
        unlock_vault(&state).expect("unlock");

        let created = create_entry(
            &state,
            "login".to_string(),
            login_snapshot("Email", "alice", "one"),
        )
        .expect("create");
        update_entry(
            &state,
            created.id,
            login_snapshot("Email", "alice", "two"),
        )
        .expect("update");

        let history = get_history(&state, created.id).expect("history");
        assert_eq!(history.len(), 2);
        assert!(history.iter().all(|c| !c.hash.is_empty()));
        assert!(history[0].parent.is_some());

        let older = get_commit_snapshot(&state, created.id, history[1].hash.clone()).expect("snapshot");
        assert_eq!(older.password, "one");

        delete_entry(&state, created.id).expect("trash entry");
        let trash_history = get_history(&state, created.id).expect("trash history");
        assert_eq!(trash_history.len(), 2);
        let trash_older =
            get_commit_snapshot(&state, created.id, trash_history[1].hash.clone()).expect("trash snapshot");
        assert_eq!(trash_older.password, "one");
    }

    #[test]
    fn totp_matches_rfc_6238_vectors() {
        // RFC 6238 Appendix B test vectors for HMAC-SHA1.
        // Key = ASCII "12345678901234567890" (base32 = GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ).
        let mut snapshot = EntrySnapshot::default();
        snapshot.totp_secrets = vec!["GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ".to_string()];

        let vectors: &[(i64, &str, u32)] = &[
            (59,          "287082", 1),
            (1111111109,  "081804", 1),
            (1111111111,  "050471", 29),
            (1234567890,  "005924", 30),
            (2000000000,  "279037", 10),
            (20000000000, "353130", 10),
        ];

        for &(ts, expected_code, expected_remaining) in vectors {
            let codes = get_totp_from_snapshot_at_timestamp(&snapshot, ts)
                .unwrap_or_else(|_| panic!("totp failed at ts={ts}"));
            assert_eq!(codes[0].code, expected_code, "wrong code at ts={ts}");
            assert_eq!(codes[0].remaining_secs, expected_remaining, "wrong remaining at ts={ts}");
        }
    }

    #[test]
    fn get_totp_supports_multiple_secrets() {
        let state = new_state(vec![2_u8; 256], "alice");
        init_vault(&state, "alice".to_string()).expect("init");
        unlock_vault(&state).expect("unlock");

        let mut snapshot = login_snapshot("2FA", "alice", "pw");
        snapshot.totp_secrets = vec![
            "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ".to_string(),
            "JBSWY3DPEHPK3PXP".to_string(),
        ];
        let created = create_entry(&state, "login".to_string(), snapshot).expect("create");

        let codes = get_totp(&state, created.id).expect("totp");
        assert_eq!(codes.len(), 2);
        assert!(codes.iter().all(|c| c.code.len() == 6));
        assert!(codes.iter().all(|c| (1..=30).contains(&c.remaining_secs)));
    }

    #[test]
    fn export_contains_active_and_trashed_entries() {
        let state = new_state(vec![4_u8; 256], "alice");
        init_vault(&state, "alice".to_string()).expect("init");
        unlock_vault(&state).expect("unlock");

        let active = create_entry(
            &state,
            "login".to_string(),
            login_snapshot("Active", "alice", "pw"),
        )
        .expect("active");
        let trashed = create_entry(
            &state,
            "note".to_string(),
            EntrySnapshot {
                title: "Trashed".to_string(),
                notes: "gone".to_string(),
                ..EntrySnapshot::default()
            },
        )
        .expect("trashed");
        delete_entry(&state, trashed.id).expect("trash");

        let json = export_vault(&state).expect("export");
        let parsed: serde_json::Value = serde_json::from_str(&json).expect("valid json");
        assert_eq!(parsed["version"], 1);
        assert_eq!(parsed["username"], "alice");

        let data = parsed["data"].as_array().expect("data array");
        let trash = parsed["trash"].as_array().expect("trash array");
        assert_eq!(data.len(), 1);
        assert_eq!(trash.len(), 1);
        assert_eq!(data[0]["id"], active.id);
        assert!(data[0]["_commits"].is_array());
        assert_eq!(trash[0]["id"], trashed.id);
        assert!(trash[0]["deletedAt"].as_str().is_some());
    }

    #[test]
    fn rotate_master_key_reencrypts_umk_blob() {
        let old_root = vec![6_u8; 256];
        let state = new_state(old_root.clone(), "alice");
        init_vault(&state, "alice".to_string()).expect("init");
        unlock_vault(&state).expect("unlock");
        create_entry(
            &state,
            "login".to_string(),
            login_snapshot("Entry", "alice", "pw"),
        )
        .expect("create");

        let new_root = vec![9_u8; 256];
        let new_root_b64 = general_purpose::STANDARD.encode(&new_root);
        rotate_master_key(&state, new_root_b64).expect("rotate");
        lock_vault(&state).expect("lock");

        let state_config = state.config.lock().expect("config").clone();
        let old_state = AppState::new(
            open_connection(&state_config.db_path).expect("open db old"),
            AppConfig {
                root_master_key: old_root,
                db_path: state_config.db_path.clone(),
                username: "alice".to_string(),
                backup_on_save: false,
                log_level: "warn".to_string(),
                targets: Default::default(),
            },
        );
        let old_err = unlock_vault(&old_state).expect_err("old key must fail");
        assert!(matches!(old_err, AppError::WrongRootMasterKey));

        let new_state = AppState::new(
            open_connection(&state_config.db_path).expect("open db new"),
            AppConfig {
                root_master_key: new_root,
                db_path: state_config.db_path.clone(),
                username: "alice".to_string(),
                backup_on_save: false,
                log_level: "warn".to_string(),
                targets: Default::default(),
            },
        );
        unlock_vault(&new_state).expect("new key unlocks");
        let entries = list_entries(&new_state, None).expect("entries intact");
        assert_eq!(entries.len(), 1);
    }

    #[test]
    fn vault_stats_include_counts_commits_and_tags() {
        let state = new_state(vec![8_u8; 256], "alice");
        init_vault(&state, "alice".to_string()).expect("init");
        unlock_vault(&state).expect("unlock");

        let login_id = create_entry(
            &state,
            "login".to_string(),
            EntrySnapshot {
                title: "Login".to_string(),
                tags: vec!["Work".to_string(), "Email".to_string()],
                ..EntrySnapshot::default()
            },
        )
        .expect("login")
        .id;
        create_entry(
            &state,
            "note".to_string(),
            EntrySnapshot {
                title: "Note".to_string(),
                tags: vec!["Work".to_string()],
                ..EntrySnapshot::default()
            },
        )
        .expect("note");
        let card_id = create_entry(
            &state,
            "card".to_string(),
            EntrySnapshot {
                title: "Card".to_string(),
                tags: vec!["Billing".to_string()],
                ..EntrySnapshot::default()
            },
        )
        .expect("card")
        .id;

        update_entry(
            &state,
            login_id,
            EntrySnapshot {
                title: "Login".to_string(),
                password: "changed".to_string(),
                tags: vec!["work".to_string(), "email".to_string()],
                ..EntrySnapshot::default()
            },
        )
        .expect("update login");
        delete_entry(&state, card_id).expect("trash card");

        let stats = get_vault_stats(&state).expect("stats");
        assert_eq!(stats.entry_count, 2);
        assert_eq!(stats.trash_count, 1);
        assert_eq!(stats.login_count, 1);
        assert_eq!(stats.note_count, 1);
        assert_eq!(stats.card_count, 0);
        assert_eq!(stats.total_commits, 3);
        assert!((stats.avg_commits_per_entry - 1.5).abs() < f64::EPSILON);
        assert_eq!(stats.top_tags[0].tag, "work");
        assert_eq!(stats.top_tags[0].count, 2);
    }
}
