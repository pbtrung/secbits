use std::sync::Mutex;

use rusqlite::Connection;
use zeroize::Zeroize;

use crate::config::AppConfig;

#[derive(Debug, Default)]
pub struct SessionState {
    user_master_key: Option<Vec<u8>>,
}

impl SessionState {
    pub fn set_user_master_key(&mut self, key: Vec<u8>) {
        self.clear();
        self.user_master_key = Some(key);
    }

    pub fn user_master_key(&self) -> Option<Vec<u8>> {
        self.user_master_key.clone()
    }

    pub fn is_unlocked(&self) -> bool {
        self.user_master_key.is_some()
    }

    pub fn clear(&mut self) {
        if let Some(mut key) = self.user_master_key.take() {
            key.zeroize();
        }
    }
}

impl Drop for SessionState {
    fn drop(&mut self) {
        self.clear();
    }
}

pub struct AppState {
    pub conn: Mutex<Connection>,
    pub session: Mutex<SessionState>,
    pub config: AppConfig,
}

impl AppState {
    pub fn new(conn: Connection, config: AppConfig) -> Self {
        Self {
            conn: Mutex::new(conn),
            session: Mutex::new(SessionState::default()),
            config,
        }
    }
}
