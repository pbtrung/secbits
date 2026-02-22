use clap::Parser;

fn main() {
    if let Err(err) = run() {
        eprintln!("error: {err}");
        std::process::exit(1);
    }
}

fn run() -> secbits::Result<()> {
    let cli = secbits::cli::Cli::parse();
    secbits::logging::init()?;
    secbits::app::dispatch(cli)
}
