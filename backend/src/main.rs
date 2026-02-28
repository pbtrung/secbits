#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use secbits::commands;
use secbits::config::load_config;
use secbits::db::{create_schema, open_connection};
use secbits::state::AppState;

fn main() {
    let config = load_config(None).expect("failed to load config");
    let conn = open_connection(&config.db_path).expect("failed to open sqlite database");
    create_schema(&conn).expect("failed to create schema");
    let state = AppState::new(conn, config);

    tauri::Builder::default()
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            commands::init_vault,
            commands::is_initialized,
            commands::unlock_vault,
            commands::lock_vault,
            commands::create_entry,
            commands::get_entry,
            commands::update_entry,
            commands::delete_entry,
            commands::list_entries,
            commands::list_trash,
            commands::get_trash_entry,
            commands::restore_entry,
            commands::purge_entry,
            commands::restore_to_commit
        ])
        .run(tauri::generate_context!())
        .expect("failed to run SecBits Tauri app");
}
