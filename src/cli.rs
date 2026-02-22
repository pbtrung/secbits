use std::path::PathBuf;

use clap::{ArgGroup, Parser, Subcommand};

#[derive(Debug, Parser)]
#[command(name = "secbits")]
#[command(about = "Offline-first password manager CLI")]
pub struct Cli {
    #[arg(long, global = true, value_name = "path")]
    pub config: Option<PathBuf>,

    #[command(subcommand)]
    pub command: Commands,
}

#[derive(Debug, Subcommand)]
pub enum Commands {
    Init {
        #[arg(long, value_name = "name")]
        username: String,
    },
    Ls {
        #[arg(value_name = "prefix")]
        prefix: Option<String>,
    },
    Show {
        #[arg(value_name = "path")]
        path: String,
    },
    Insert {
        #[arg(value_name = "path")]
        path: String,
    },
    Edit {
        #[arg(value_name = "path")]
        path: String,
    },
    Rm {
        #[arg(value_name = "path")]
        path: String,
    },
    History {
        #[arg(value_name = "path")]
        path: String,
    },
    Restore {
        #[arg(value_name = "path")]
        path: String,
        #[arg(long, value_name = "hash")]
        commit: String,
    },
    Totp {
        #[arg(value_name = "path")]
        path: String,
    },
    Export {
        #[arg(long, value_name = "file")]
        output: PathBuf,
    },
    Backup {
        #[command(subcommand)]
        command: BackupCommands,
    },
}

#[derive(Debug, Subcommand)]
pub enum BackupCommands {
    #[command(group(
        ArgGroup::new("backup_destination")
            .required(true)
            .args(["target", "all"])
            .multiple(false)
    ))]
    Push {
        #[arg(long, value_name = "name")]
        target: Option<String>,
        #[arg(long)]
        all: bool,
    },
    Pull {
        #[arg(long, value_name = "name")]
        target: String,
        #[arg(long, value_name = "key")]
        object: Option<String>,
    },
}

#[cfg(test)]
mod tests {
    use clap::CommandFactory;

    use super::Cli;

    #[test]
    fn clap_definition_is_valid() {
        Cli::command().debug_assert();
    }
}
