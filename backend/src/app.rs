use chrono::Utc;
use rand::TryRngCore;
use rand::rngs::OsRng;
use zeroize::Zeroize;

use crate::Result;
use crate::crypto::{USER_MASTER_KEY_LEN, decrypt_bytes_from_blob, encrypt_bytes_to_blob};
use crate::db;
use crate::error::AppError;
use crate::state::AppState;

pub fn init_vault(state: &AppState, username: String) -> Result<()> {
    let conn = state
        .conn
        .lock()
        .map_err(|_| AppError::Other("database mutex poisoned".to_string()))?;

    db::create_schema(&conn)?;

    if db::get_vault_info(&conn, "username")?.is_some() || db::get_umk_blob(&conn)?.is_some() {
        return Err(AppError::DatabaseAlreadyInitialized);
    }

    let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
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

#[cfg(test)]
mod tests {
    use base64::{Engine as _, engine::general_purpose};
    use tempfile::tempdir;

    use super::{init_vault, is_initialized, lock_vault, unlock_vault};
    use crate::config::AppConfig;
    use crate::db::open_connection;
    use crate::error::AppError;
    use crate::state::AppState;

    fn new_state(root_key: Vec<u8>, username: &str) -> AppState {
        let dir = tempdir().expect("tempdir");
        let db_path = dir.path().join("vault.db");
        let conn = open_connection(&db_path).expect("open db");
        crate::db::create_schema(&conn).expect("create schema");

        // Keep tempdir alive by leaking; test process cleanup will reclaim.
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
    fn init_rejects_second_initialization() {
        let key_b64 = general_purpose::STANDARD.encode(vec![1_u8; 256]);
        let root_key = general_purpose::STANDARD
            .decode(key_b64)
            .expect("decode");
        let state = new_state(root_key, "alice");

        init_vault(&state, "alice".to_string()).expect("init");
        let err = init_vault(&state, "alice".to_string()).expect_err("second init fails");
        assert!(matches!(err, AppError::DatabaseAlreadyInitialized));
    }
}
