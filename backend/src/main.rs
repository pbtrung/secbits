#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use secbits::commands;
use secbits::config::load_config;
use secbits::db::{create_schema, open_connection};
use secbits::state::AppState;

fn main() {
    // Force X11 backend on Linux so KDE (and other WMs) provide native
    // server-side window decorations instead of GTK/libdecor CSD, which
    // breaks resize handles and window controls under KDE Plasma + Wayland.
    #[cfg(target_os = "linux")]
    unsafe {
        std::env::set_var("GDK_BACKEND", "x11");
    }

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
            commands::restore_to_commit,
            commands::get_history,
            commands::get_commit_snapshot,
            commands::get_totp,
            commands::export_vault,
            commands::rotate_master_key,
            commands::get_vault_stats
        ])
        .run(tauri::generate_context!())
        .expect("failed to run SecBits Tauri app");
}
