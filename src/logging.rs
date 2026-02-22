use tracing_subscriber::EnvFilter;

use crate::error::AppError;
use crate::Result;

pub fn init() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .with_target(false)
        .without_time()
        .try_init()
        .map_err(|err| AppError::Logging(err.to_string()))?;

    Ok(())
}
