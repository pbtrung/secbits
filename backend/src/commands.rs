use crate::Result;
use crate::app;
use crate::model::EntrySnapshot;
use crate::state::AppState;

#[tauri::command]
pub fn init_vault(state: tauri::State<'_, AppState>, username: String) -> Result<()> {
    app::init_vault(&state, username)
}

#[tauri::command]
pub fn is_initialized(state: tauri::State<'_, AppState>) -> Result<bool> {
    app::is_initialized(&state)
}

#[tauri::command]
pub fn unlock_vault(state: tauri::State<'_, AppState>) -> Result<()> {
    app::unlock_vault(&state)
}

#[tauri::command]
pub fn lock_vault(state: tauri::State<'_, AppState>) -> Result<()> {
    app::lock_vault(&state)
}

#[tauri::command]
pub fn create_entry(
    state: tauri::State<'_, AppState>,
    entry_type: String,
    snapshot: EntrySnapshot,
) -> Result<app::EntryMeta> {
    app::create_entry(&state, entry_type, snapshot)
}

#[tauri::command]
pub fn get_entry(state: tauri::State<'_, AppState>, id: i64) -> Result<app::EntryDetail> {
    app::get_entry(&state, id)
}

#[tauri::command]
pub fn update_entry(
    state: tauri::State<'_, AppState>,
    id: i64,
    snapshot: EntrySnapshot,
) -> Result<app::EntryMeta> {
    app::update_entry(&state, id, snapshot)
}

#[tauri::command]
pub fn delete_entry(state: tauri::State<'_, AppState>, id: i64) -> Result<()> {
    app::delete_entry(&state, id)
}

#[tauri::command]
pub fn list_entries(
    state: tauri::State<'_, AppState>,
    filter: Option<String>,
) -> Result<Vec<app::EntryMeta>> {
    app::list_entries(&state, filter)
}

#[tauri::command]
pub fn list_trash(state: tauri::State<'_, AppState>) -> Result<Vec<app::TrashedEntryMeta>> {
    app::list_trash(&state)
}

#[tauri::command]
pub fn get_trash_entry(state: tauri::State<'_, AppState>, id: i64) -> Result<app::EntryDetail> {
    app::get_trash_entry(&state, id)
}

#[tauri::command]
pub fn restore_entry(state: tauri::State<'_, AppState>, id: i64) -> Result<app::EntryMeta> {
    app::restore_entry(&state, id)
}

#[tauri::command]
pub fn purge_entry(state: tauri::State<'_, AppState>, id: i64) -> Result<()> {
    app::purge_entry(&state, id)
}

#[tauri::command]
pub fn restore_to_commit(
    state: tauri::State<'_, AppState>,
    id: i64,
    hash: String,
) -> Result<app::EntryMeta> {
    app::restore_to_commit(&state, id, hash)
}

#[tauri::command]
pub fn get_history(state: tauri::State<'_, AppState>, id: i64) -> Result<Vec<app::CommitMeta>> {
    app::get_history(&state, id)
}

#[tauri::command]
pub fn get_commit_snapshot(
    state: tauri::State<'_, AppState>,
    id: i64,
    hash: String,
) -> Result<EntrySnapshot> {
    app::get_commit_snapshot(&state, id, hash)
}

#[tauri::command]
pub fn get_totp(state: tauri::State<'_, AppState>, id: i64) -> Result<Vec<app::TotpResult>> {
    app::get_totp(&state, id)
}

#[tauri::command]
pub fn export_vault(state: tauri::State<'_, AppState>) -> Result<String> {
    app::export_vault(&state)
}

#[tauri::command]
pub fn generate_root_master_key() -> Result<String> {
    app::generate_root_master_key()
}

#[tauri::command]
pub fn rotate_master_key(state: tauri::State<'_, AppState>, new_key_b64: String) -> Result<()> {
    app::rotate_master_key(&state, new_key_b64)
}

#[tauri::command]
pub fn get_vault_stats(state: tauri::State<'_, AppState>) -> Result<app::VaultStats> {
    app::get_vault_stats(&state)
}
