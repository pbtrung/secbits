use zeroize::Zeroize;

use crate::cli::{BackupCommands, Cli, Commands};
use crate::config::load_config;
use crate::crypto::{
    create_user_master_key_blob, validate_root_master_key_b64, verify_user_master_key_blob,
};
use crate::db::Database;
use crate::error::AppError;
use crate::Result;

pub fn dispatch(cli: Cli) -> Result<()> {
    let config = load_config(cli.config)?;
    let mut root_master_key = validate_root_master_key_b64(&config.root_master_key_b64)?;

    let db = Database::open(&config.db_path)?;

    let result = match &cli.command {
        Commands::Init { username } => {
            handle_init(&db, &root_master_key, &config.username, username)
        }
        other => {
            let mut user_master_key =
                authenticate_session(&db, &config.username, &root_master_key)?;
            let command_name = command_name(other);
            user_master_key.zeroize();
            Err(AppError::CommandNotImplemented(command_name))
        }
    };

    root_master_key.zeroize();
    result
}

fn handle_init(
    db: &Database,
    root_master_key: &[u8],
    configured_username: &str,
    command_username: &str,
) -> Result<()> {
    if configured_username != command_username {
        return Err(AppError::InvalidConfigField(
            "init --username must match config username".to_string(),
        ));
    }

    if let Some(existing_user) = db.get_user_by_username(command_username)? {
        let mut user_master_key =
            verify_user_master_key_blob(root_master_key, &existing_user.user_master_key)?;
        user_master_key.zeroize();
        return Ok(());
    }

    let (mut user_master_key, user_master_key_blob) = create_user_master_key_blob(root_master_key)?;
    db.create_user(command_username, &user_master_key_blob)?;
    user_master_key.zeroize();

    Ok(())
}

fn authenticate_session(db: &Database, username: &str, root_master_key: &[u8]) -> Result<Vec<u8>> {
    let user = db
        .get_user_by_username(username)?
        .ok_or(AppError::UserNotFound)?;

    verify_user_master_key_blob(root_master_key, &user.user_master_key)
}

fn command_name(command: &Commands) -> &'static str {
    match command {
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
    }
}
