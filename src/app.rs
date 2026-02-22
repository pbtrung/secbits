use crate::cli::{BackupCommands, Cli, Commands};
use crate::error::AppError;
use crate::Result;

pub fn dispatch(cli: Cli) -> Result<()> {
    let command_name = match cli.command {
        Commands::Init { .. } => "init",
        Commands::Ls { .. } => "ls",
        Commands::Show { .. } => "show",
        Commands::Insert { .. } => "insert",
        Commands::Edit { .. } => "edit",
        Commands::Rm { .. } => "rm",
        Commands::History { .. } => "history",
        Commands::Restore { .. } => "restore",
        Commands::Totp { .. } => "totp",
        Commands::Export { .. } => "export",
        Commands::Backup { command } => match command {
            BackupCommands::Push { .. } => "backup push",
            BackupCommands::Pull { .. } => "backup pull",
        },
        Commands::ShareInit => "share-init",
        Commands::SharePubkey { .. } => "share-pubkey",
        Commands::Share { .. } => "share",
        Commands::ShareReceive { .. } => "share-receive",
    };

    Err(AppError::CommandNotImplemented(command_name))
}
