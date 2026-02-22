use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("failed to initialize logging: {0}")]
    Logging(String),

    #[error("command not implemented yet: {0}")]
    CommandNotImplemented(&'static str),
}
