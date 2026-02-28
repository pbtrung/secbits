use crate::Result;
use crate::app;
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
