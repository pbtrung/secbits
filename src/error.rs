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

    #[error("config file not found: {0}")]
    ConfigFileNotFound(String),

    #[error("invalid config field: {0}")]
    InvalidConfigField(String),

    #[error("invalid root master key format")]
    InvalidRootMasterKeyFormat,

    #[error("root master key too short")]
    RootMasterKeyTooShort,

    #[error("wrong root master key")]
    WrongRootMasterKey,

    #[error("invalid stored user master key blob")]
    InvalidStoredUserMasterKeyBlob,

    #[error("invalid encrypted blob")]
    InvalidBlob,

    #[error("decryption failed authentication")]
    DecryptionFailedAuthentication,

    #[error("key derivation failed")]
    KeyDerivationFailed,

    #[error("leancrypto operation failed with code {0}")]
    CryptoOperationFailed(i32),

    #[error("leancrypto AEAD algorithm mismatch: expected Ascon-Keccak")]
    CryptoAlgorithmMismatch,

    #[error("invalid key material")]
    InvalidKeyMaterial,

    #[error("user not found")]
    UserNotFound,

    #[error("invalid entry key blob")]
    InvalidEntryKeyBlob,

    #[error("path already exists")]
    PathAlreadyExists,

    #[error("path not found")]
    PathNotFound,

    #[error("path is ambiguous: {0}")]
    PathAmbiguous(String),

    #[error("invalid path hint")]
    InvalidPathHint,

    #[error("commit not found")]
    CommitNotFound,

    #[error("history corrupted")]
    HistoryCorrupted,

    #[error("no totp secrets")]
    NoTotpSecrets,

    #[error("export failed")]
    ExportFailed,

    #[error("password confirmation mismatch")]
    PasswordConfirmationMismatch,

    #[error("invalid totp secret")]
    InvalidTotpSecret,

    #[error("aborted")]
    Aborted,

    #[error("command not implemented yet: {0}")]
    CommandNotImplemented(&'static str),
}
