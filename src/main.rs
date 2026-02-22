use clap::Parser;

fn main() {
    if let Err(err) = run() {
        eprintln!("error: {err}");
        std::process::exit(1);
    }
}

fn run() -> secbits::Result<()> {
    let cli = secbits::cli::Cli::parse();
    let config = match secbits::config::load_config(cli.config.clone()) {
        Ok(config) => config,
        Err(err) => {
            eprintln!("error: {err}");
            return Err(err);
        }
    };

    if let Err(err) = secbits::logging::init(&config.logging) {
        eprintln!("error: {err}");
        return Err(err);
    }

    let result = secbits::app::dispatch(cli, config);
    if let Err(err) = &result {
        tracing::error!(error = %err, "command failed");
    }

    result
}
