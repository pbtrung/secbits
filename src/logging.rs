use tracing_subscriber::EnvFilter;

use crate::config::LoggingConfig;
use crate::error::AppError;
use crate::Result;

pub fn init(config: &LoggingConfig) -> Result<()> {
    let env_filter = EnvFilter::try_new(config.level.as_str())
        .map_err(|err| AppError::Logging(err.to_string()))?;

    if config.time {
        tracing_subscriber::fmt()
            .with_env_filter(env_filter)
            .with_target(config.target)
            .try_init()
            .map_err(|err| AppError::Logging(err.to_string()))?;
    } else {
        tracing_subscriber::fmt()
            .with_env_filter(env_filter)
            .with_target(config.target)
            .without_time()
            .try_init()
            .map_err(|err| AppError::Logging(err.to_string()))?;
    }

    Ok(())
}
