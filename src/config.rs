use std::env;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::error::AppError;
use crate::Result;

const DEFAULT_CONFIG_PATH: &str = "~/.config/secbits/config.toml";
const SECBITS_CONFIG_ENV: &str = "SECBITS_CONFIG";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppConfig {
    pub root_master_key_b64: String,
    pub db_path: PathBuf,
    pub username: String,
    pub backup_on_save: bool,
    pub logging: LoggingConfig,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoggingConfig {
    pub level: String,
    pub target: bool,
    pub time: bool,
}

#[derive(Debug, Deserialize)]
struct FileConfig {
    root_master_key_b64: String,
    db_path: String,
    username: String,
    backup_on_save: Option<bool>,
    log_level: Option<String>,
    log_target: Option<bool>,
    log_time: Option<bool>,
}

pub fn load_config(explicit_path: Option<PathBuf>) -> Result<AppConfig> {
    let config_path = resolve_config_path(explicit_path)?;
    let contents = fs::read_to_string(&config_path).map_err(|err| match err.kind() {
        ErrorKind::NotFound => AppError::ConfigFileNotFound(config_path.display().to_string()),
        _ => AppError::Io(err),
    })?;

    let parsed: FileConfig =
        toml::from_str(&contents).map_err(|err| AppError::InvalidConfigField(err.to_string()))?;

    if parsed.root_master_key_b64.trim().is_empty() {
        return Err(AppError::InvalidConfigField(
            "root_master_key_b64 must not be empty".to_string(),
        ));
    }

    if parsed.db_path.trim().is_empty() {
        return Err(AppError::InvalidConfigField(
            "db_path must not be empty".to_string(),
        ));
    }

    if parsed.username.trim().is_empty() {
        return Err(AppError::InvalidConfigField(
            "username must not be empty".to_string(),
        ));
    }

    let db_path = expand_tilde(&parsed.db_path)?;
    let log_level = parsed.log_level.unwrap_or_else(|| "info".to_string());
    validate_log_level(&log_level)?;

    Ok(AppConfig {
        root_master_key_b64: parsed.root_master_key_b64,
        db_path,
        username: parsed.username,
        backup_on_save: parsed.backup_on_save.unwrap_or(false),
        logging: LoggingConfig {
            level: log_level,
            target: parsed.log_target.unwrap_or(false),
            time: parsed.log_time.unwrap_or(false),
        },
    })
}

fn resolve_config_path(explicit_path: Option<PathBuf>) -> Result<PathBuf> {
    if let Some(path) = explicit_path {
        return expand_tilde(path);
    }

    if let Ok(path) = env::var(SECBITS_CONFIG_ENV) {
        if !path.trim().is_empty() {
            return expand_tilde(path);
        }
    }

    expand_tilde(DEFAULT_CONFIG_PATH)
}

fn expand_tilde(input: impl AsRef<Path>) -> Result<PathBuf> {
    let path = input.as_ref();

    if !path.starts_with("~") {
        return Ok(path.to_path_buf());
    }

    let home = env::var("HOME")
        .map_err(|_| AppError::InvalidConfigField("HOME is not set".to_string()))?;

    if path == Path::new("~") {
        return Ok(PathBuf::from(home));
    }

    let suffix = path
        .strip_prefix("~/")
        .map_err(|_| AppError::InvalidConfigField("unsupported path using ~".to_string()))?;

    Ok(PathBuf::from(home).join(suffix))
}

fn validate_log_level(level: &str) -> Result<()> {
    match level {
        "trace" | "debug" | "info" | "warn" | "error" => Ok(()),
        _ => Err(AppError::InvalidConfigField(
            "log_level must be one of: trace, debug, info, warn, error".to_string(),
        )),
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use super::load_config;
    use crate::error::AppError;

    #[test]
    fn load_config_parses_required_fields() {
        let dir = tempdir().expect("tempdir");
        let config_path = dir.path().join("config.toml");

        fs::write(
            &config_path,
            "root_master_key_b64 = \"abc\"\ndb_path = \"/tmp/secbits.db\"\nusername = \"alice\"\n",
        )
        .expect("write");

        let config = load_config(Some(config_path)).expect("loads");
        assert_eq!(config.root_master_key_b64, "abc");
        assert_eq!(config.username, "alice");
        assert!(!config.backup_on_save);
        assert_eq!(config.logging.level, "info");
        assert!(!config.logging.target);
        assert!(!config.logging.time);
    }

    #[test]
    fn load_config_rejects_empty_db_path() {
        let dir = tempdir().expect("tempdir");
        let config_path = dir.path().join("config.toml");

        fs::write(
            &config_path,
            "root_master_key_b64 = \"abc\"\ndb_path = \"\"\nusername = \"alice\"\n",
        )
        .expect("write");

        let err = load_config(Some(config_path)).expect_err("must fail");
        assert!(matches!(err, AppError::InvalidConfigField(_)));
    }

    #[test]
    fn load_config_rejects_empty_username() {
        let dir = tempdir().expect("tempdir");
        let config_path = dir.path().join("config.toml");

        fs::write(
            &config_path,
            "root_master_key_b64 = \"abc\"\ndb_path = \"/tmp/secbits.db\"\nusername = \"\"\n",
        )
        .expect("write");

        let err = load_config(Some(config_path)).expect_err("must fail");
        assert!(matches!(err, AppError::InvalidConfigField(_)));
    }

    #[test]
    fn load_config_rejects_invalid_log_level() {
        let dir = tempdir().expect("tempdir");
        let config_path = dir.path().join("config.toml");

        fs::write(
            &config_path,
            "root_master_key_b64 = \"abc\"\ndb_path = \"/tmp/secbits.db\"\nusername = \"alice\"\nlog_level = \"verbose\"\n",
        )
        .expect("write");

        let err = load_config(Some(config_path)).expect_err("must fail");
        assert!(matches!(err, AppError::InvalidConfigField(_)));
    }
}
