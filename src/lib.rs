pub mod app;
pub mod backup;
pub mod cli;
pub mod compression;
pub mod crypto;
pub mod db;
pub mod error;
pub mod logging;
pub mod model;

pub type Result<T> = std::result::Result<T, error::AppError>;
