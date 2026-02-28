pub mod compression;
pub mod crypto;
pub mod error;

pub type Result<T> = std::result::Result<T, error::AppError>;
