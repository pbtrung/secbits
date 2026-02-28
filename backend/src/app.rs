use chrono::Utc;
use rand::TryRngCore;
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

use crate::Result;
use crate::compression::{compress, decompress};
use crate::crypto::{DOC_KEY_LEN, USER_MASTER_KEY_LEN, decrypt_bytes_from_blob, encrypt_bytes_to_blob};
use crate::db;
use crate::error::AppError;
use crate::model::{EntrySnapshot, HistoryObject, append_snapshot, restore_to_commit as model_restore_to_commit};
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

pub fn init_vault(state: &AppState, username: String) -> Result<()> {
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

    let umk_blob = encrypt_bytes_to_blob(&state.config.root_master_key, &user_master_key)?;
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
    let conn = state
        .conn
        .lock()
        .map_err(|_| AppError::Other("database mutex poisoned".to_string()))?;
    db::create_schema(&conn)?;

    let username = db::get_vault_info(&conn, "username")?.ok_or(AppError::UserNotFound)?;
    if username != state.config.username {
        return Err(AppError::UserNotFound);
    }

    let umk_blob = db::get_umk_blob(&conn)?.ok_or(AppError::UserNotFound)?;

    let user_master_key = match decrypt_bytes_from_blob(&state.config.root_master_key, &umk_blob) {
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

fn require_unlocked_umk(state: &AppState) -> Result<Vec<u8>> {
    let session = state
        .session
        .lock()
        .map_err(|_| AppError::Other("session mutex poisoned".to_string()))?;
    session.user_master_key().ok_or(AppError::SessionLocked)
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

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::{
        create_entry, delete_entry, get_entry, get_trash_entry, init_vault, is_initialized, list_entries,
        list_trash, lock_vault, purge_entry, restore_entry, restore_to_commit, unlock_vault,
        update_entry,
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
        let wrong_state = AppState::new(
            open_connection(&state.config.db_path).expect("open shared db"),
            AppConfig {
                root_master_key: wrong_root,
                db_path: state.config.db_path.clone(),
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
}
