use clap::Parser;

fn main() {
    if let Err(err) = run() {
        eprintln!("error: {err}");
        std::process::exit(1);
    }
}

fn run() -> secbits::Result<()> {
    let cli = secbits::cli::Cli::parse();
    let config = secbits::config::load_config(cli.config.clone())?;
    secbits::logging::init(&config.logging)?;
    secbits::app::dispatch(cli, config)
}
