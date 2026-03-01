use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use base64::{Engine as _, engine::general_purpose};
use serde::Deserialize;

use crate::Result;
use crate::error::AppError;

const DEFAULT_CONFIG_PATH: &str = "~/.config/secbits/config.toml";
const CONFIG_ENV: &str = "SECBITS_CONFIG";
const MIN_ROOT_MASTER_KEY_LEN: usize = 256;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppConfig {
    pub root_master_key: Vec<u8>,
    pub db_path: PathBuf,
    pub username: String,
    pub backup_on_save: bool,
    pub log_level: String,
    pub targets: BTreeMap<String, BackupTargetConfig>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct BackupTargetConfig {
    pub endpoint: String,
    pub bucket: String,
    pub access_key: String,
    pub secret_key: String,
    pub region: String,
}

#[derive(Debug, Deserialize)]
struct FileConfig {
    root_master_key: String,
    db_path: String,
    username: String,
    backup_on_save: Option<bool>,
    log_level: Option<String>,
    targets: Option<BTreeMap<String, BackupTargetConfig>>,
}

pub fn load_config(explicit_path: Option<PathBuf>) -> Result<AppConfig> {
    let path = resolve_config_path(explicit_path)?;
    let raw = fs::read_to_string(&path).map_err(|_| AppError::ConfigNotFound)?;
    let parsed: FileConfig = toml::from_str(&raw).map_err(|e| AppError::ConfigParse(e.to_string()))?;

    let root_master_key = decode_root_master_key(&parsed.root_master_key)?;

    if parsed.username.trim().is_empty() {
        return Err(AppError::ConfigParse("username must not be empty".to_string()));
    }

    if parsed.db_path.trim().is_empty() {
        return Err(AppError::ConfigParse("db_path must not be empty".to_string()));
    }

    let db_path = expand_tilde(parsed.db_path)?;

    Ok(AppConfig {
        root_master_key,
        db_path,
        username: parsed.username,
        backup_on_save: parsed.backup_on_save.unwrap_or(false),
        log_level: parsed.log_level.unwrap_or_else(|| "warn".to_string()),
        targets: parsed.targets.unwrap_or_default(),
    })
}

pub fn default_config_path() -> Result<PathBuf> {
    expand_tilde(DEFAULT_CONFIG_PATH)
}

pub fn decode_root_master_key(raw: &str) -> Result<Vec<u8>> {
    let decoded = general_purpose::STANDARD
        .decode(raw.trim())
        .map_err(|_| AppError::InvalidRootMasterKeyFormat)?;

    if decoded.len() < MIN_ROOT_MASTER_KEY_LEN {
        return Err(AppError::RootMasterKeyTooShort);
    }

    Ok(decoded)
}

fn resolve_config_path(explicit_path: Option<PathBuf>) -> Result<PathBuf> {
    if let Some(path) = explicit_path {
        return expand_tilde(path);
    }

    if let Ok(path) = env::var(CONFIG_ENV) {
        if !path.trim().is_empty() {
            return expand_tilde(path);
        }
    }

    expand_tilde(DEFAULT_CONFIG_PATH)
}

fn expand_tilde(path: impl AsRef<Path>) -> Result<PathBuf> {
    let path = path.as_ref();

    if !path.starts_with("~") {
        return Ok(path.to_path_buf());
    }

    let home = env::var("HOME").map_err(|_| AppError::ConfigNotFound)?;

    if path == Path::new("~") {
        return Ok(PathBuf::from(home));
    }

    let suffix = path
        .strip_prefix("~/")
        .map_err(|_| AppError::ConfigParse("unsupported path using ~".to_string()))?;

    Ok(PathBuf::from(home).join(suffix))
}

#[cfg(test)]
mod tests {
    use std::fs;

    use base64::{Engine as _, engine::general_purpose};
    use tempfile::tempdir;

    use super::load_config;
    use crate::error::AppError;

    fn key_b64(len: usize) -> String {
        general_purpose::STANDARD.encode(vec![7_u8; len])
    }

    #[test]
    fn parses_valid_config() {
        let dir = tempdir().expect("tempdir");
        let db_path = dir.path().join("vault.db");
        let config_path = dir.path().join("config.toml");

        fs::write(
            &config_path,
            format!(
                "root_master_key = \"{}\"\ndb_path = \"{}\"\nusername = \"alice\"\nbackup_on_save = true\n[targets.r2]\nendpoint = \"https://example.com\"\nbucket = \"bucket\"\naccess_key = \"a\"\nsecret_key = \"b\"\nregion = \"auto\"\n",
                key_b64(256),
                db_path.display()
            ),
        )
        .expect("write config");

        let cfg = load_config(Some(config_path)).expect("config parses");
        assert_eq!(cfg.username, "alice");
        assert_eq!(cfg.db_path, db_path);
        assert!(cfg.backup_on_save);
        assert_eq!(cfg.root_master_key.len(), 256);
        assert!(cfg.targets.contains_key("r2"));
    }

    #[test]
    fn rejects_invalid_base64_root_key() {
        let dir = tempdir().expect("tempdir");
        let config_path = dir.path().join("config.toml");

        fs::write(
            &config_path,
            "root_master_key = \"%%%\"\ndb_path = \"/tmp/vault.db\"\nusername = \"alice\"\n",
        )
        .expect("write config");

        let err = load_config(Some(config_path)).expect_err("must fail");
        assert!(matches!(err, AppError::InvalidRootMasterKeyFormat));
    }

    #[test]
    fn rejects_short_root_key() {
        let dir = tempdir().expect("tempdir");
        let config_path = dir.path().join("config.toml");

        fs::write(
            &config_path,
            format!(
                "root_master_key = \"{}\"\ndb_path = \"/tmp/vault.db\"\nusername = \"alice\"\n",
                key_b64(128)
            ),
        )
        .expect("write config");

        let err = load_config(Some(config_path)).expect_err("must fail");
        assert!(matches!(err, AppError::RootMasterKeyTooShort));
    }

    #[test]
    fn rejects_missing_username() {
        let dir = tempdir().expect("tempdir");
        let config_path = dir.path().join("config.toml");

        fs::write(
            &config_path,
            format!(
                "root_master_key = \"{}\"\ndb_path = \"/tmp/vault.db\"\nusername = \"\"\n",
                key_b64(256)
            ),
        )
        .expect("write config");

        let err = load_config(Some(config_path)).expect_err("must fail");
        assert!(matches!(err, AppError::ConfigParse(_)));
    }
}
