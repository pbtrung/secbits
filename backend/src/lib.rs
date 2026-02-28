pub mod app;
#[cfg(feature = "desktop")]
pub mod commands;
pub mod compression;
pub mod config;
pub mod crypto;
pub mod db;
pub mod error;
pub mod model;
pub mod state;

pub type Result<T> = std::result::Result<T, error::AppError>;
