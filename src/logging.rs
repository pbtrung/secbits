use std::fmt;

use chrono::Local;
use tracing_subscriber::fmt::time::FormatTime;
use tracing_subscriber::EnvFilter;

use crate::config::LoggingConfig;
use crate::error::AppError;
use crate::Result;

#[derive(Debug, Clone, Copy)]
struct MillisTimer;

impl FormatTime for MillisTimer {
    fn format_time(&self, w: &mut tracing_subscriber::fmt::format::Writer<'_>) -> fmt::Result {
        let now = Local::now();
        write!(w, "{}", now.format("[%d/%m/%Y %H:%M:%S%.3f]"))
    }
}

pub fn init(config: &LoggingConfig) -> Result<()> {
    let env_filter = EnvFilter::try_new(config.level.as_str())
        .map_err(|err| AppError::Logging(err.to_string()))?;

    if config.time {
        tracing_subscriber::fmt()
            .with_env_filter(env_filter)
            .with_target(config.target)
            .with_timer(MillisTimer)
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
