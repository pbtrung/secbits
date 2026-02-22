use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("failed to initialize logging: {0}")]
    Logging(String),

    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),

    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("unsupported schema version: {0}")]
    UnsupportedSchemaVersion(i64),

    #[error("invalid encrypted blob")]
    InvalidBlob,

    #[error("decryption failed authentication")]
    DecryptionFailedAuthentication,

    #[error("key derivation failed")]
    KeyDerivationFailed,

    #[error("invalid key material")]
    InvalidKeyMaterial,

    #[error("command not implemented yet: {0}")]
    CommandNotImplemented(&'static str),
}
