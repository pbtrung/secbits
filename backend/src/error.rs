use serde::Serialize;
use serde::ser::{SerializeStruct, Serializer};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("config not found")]
    ConfigNotFound,

    #[error("failed to parse config: {0}")]
    ConfigParse(String),

    #[error("database not found")]
    DatabaseNotFound,

    #[error("database already initialized")]
    DatabaseAlreadyInitialized,

    #[error("wrong root master key")]
    WrongRootMasterKey,

    #[error("user not found")]
    UserNotFound,

    #[error("invalid root master key")]
    InvalidRootMasterKey,

    #[error("invalid root master key format")]
    InvalidRootMasterKeyFormat,

    #[error("root master key too short")]
    RootMasterKeyTooShort,

    #[error("invalid blob format")]
    InvalidBlobFormat,

    #[error("unsupported blob version: {major}.{minor}")]
    UnsupportedBlobVersion { major: u8, minor: u8 },

    #[error("decryption failed authentication")]
    DecryptionFailedAuthentication,

    #[error("key derivation failed")]
    KeyDerivationFailed,

    #[error("leancrypto operation failed with code {0}")]
    CryptoOperationFailed(i32),

    #[error("leancrypto AEAD algorithm mismatch")]
    CryptoAlgorithmMismatch,

    #[error("invalid key material")]
    InvalidKeyMaterial,

    #[error("compression failed: {0}")]
    CompressionFailed(String),

    #[error("decompression failed: {0}")]
    DecompressionFailed(String),

    #[error("entry not found")]
    EntryNotFound,

    #[error("entry already exists")]
    EntryAlreadyExists,

    #[error("invalid path hint")]
    InvalidPathHint,

    #[error("commit not found")]
    CommitNotFound,

    #[error("backup target not configured")]
    BackupTargetNotConfigured,

    #[error("backup upload failed: {0}")]
    BackupUploadFailed(String),

    #[error("backup download failed: {0}")]
    BackupDownloadFailed(String),

    #[error("no TOTP secret")]
    NoTotpSecret,

    #[error("vault is locked")]
    SessionLocked,

    #[error("I/O error: {0}")]
    Io(String),

    #[error("database error: {0}")]
    Database(String),

    #[error("{0}")]
    Other(String),
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut state = if self.message().is_some() {
            serializer.serialize_struct("AppError", 2)?
        } else {
            serializer.serialize_struct("AppError", 1)?
        };

        state.serialize_field("type", self.variant_name())?;

        if let Some(message) = self.message() {
            state.serialize_field("message", &message)?;
        }

        state.end()
    }
}

impl AppError {
    fn variant_name(&self) -> &'static str {
        match self {
            Self::ConfigNotFound => "ConfigNotFound",
            Self::ConfigParse(_) => "ConfigParse",
            Self::DatabaseNotFound => "DatabaseNotFound",
            Self::DatabaseAlreadyInitialized => "DatabaseAlreadyInitialized",
            Self::WrongRootMasterKey => "WrongRootMasterKey",
            Self::UserNotFound => "UserNotFound",
            Self::InvalidRootMasterKey => "InvalidRootMasterKey",
            Self::InvalidRootMasterKeyFormat => "InvalidRootMasterKeyFormat",
            Self::RootMasterKeyTooShort => "RootMasterKeyTooShort",
            Self::InvalidBlobFormat => "InvalidBlobFormat",
            Self::UnsupportedBlobVersion { .. } => "UnsupportedBlobVersion",
            Self::DecryptionFailedAuthentication => "DecryptionFailedAuthentication",
            Self::KeyDerivationFailed => "KeyDerivationFailed",
            Self::CryptoOperationFailed(_) => "CryptoOperationFailed",
            Self::CryptoAlgorithmMismatch => "CryptoAlgorithmMismatch",
            Self::InvalidKeyMaterial => "InvalidKeyMaterial",
            Self::CompressionFailed(_) => "CompressionFailed",
            Self::DecompressionFailed(_) => "DecompressionFailed",
            Self::EntryNotFound => "EntryNotFound",
            Self::EntryAlreadyExists => "EntryAlreadyExists",
            Self::InvalidPathHint => "InvalidPathHint",
            Self::CommitNotFound => "CommitNotFound",
            Self::BackupTargetNotConfigured => "BackupTargetNotConfigured",
            Self::BackupUploadFailed(_) => "BackupUploadFailed",
            Self::BackupDownloadFailed(_) => "BackupDownloadFailed",
            Self::NoTotpSecret => "NoTotpSecret",
            Self::SessionLocked => "SessionLocked",
            Self::Io(_) => "Io",
            Self::Database(_) => "Database",
            Self::Other(_) => "Other",
        }
    }

    fn message(&self) -> Option<String> {
        match self {
            Self::UnsupportedBlobVersion { major, minor } => Some(format!("{major}.{minor}")),
            Self::ConfigParse(msg)
            | Self::CompressionFailed(msg)
            | Self::DecompressionFailed(msg)
            | Self::BackupUploadFailed(msg)
            | Self::BackupDownloadFailed(msg)
            | Self::Io(msg)
            | Self::Database(msg)
            | Self::Other(msg) => Some(msg.clone()),
            Self::CryptoOperationFailed(code) => Some(code.to_string()),
            _ => None,
        }
    }
}

impl From<std::io::Error> for AppError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value.to_string())
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(value: rusqlite::Error) -> Self {
        Self::Database(value.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::AppError;

    #[test]
    fn serializes_unit_variant_without_message() {
        let json = serde_json::to_value(&AppError::WrongRootMasterKey).expect("serializes");
        assert_eq!(json, serde_json::json!({"type": "WrongRootMasterKey"}));
    }

    #[test]
    fn serializes_data_variant_with_message() {
        let json = serde_json::to_value(&AppError::CryptoOperationFailed(-99)).expect("serializes");
        assert_eq!(
            json,
            serde_json::json!({"type": "CryptoOperationFailed", "message": "-99"})
        );
    }
}
