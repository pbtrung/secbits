use rusqlite::{Connection, OptionalExtension, params};

use crate::Result;

const UMK_KEY_TYPE: &str = "umk";

pub fn open_connection(path: &std::path::Path) -> Result<Connection> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    Ok(conn)
}

pub fn create_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS vault_info (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS key_store (
          key_id INTEGER PRIMARY KEY,
          type TEXT NOT NULL,
          label TEXT,
          value BLOB NOT NULL,
          created_at TEXT NOT NULL,
          rotated_at TEXT,
          UNIQUE(type, label)
        );

        CREATE TABLE IF NOT EXISTS entries (
          entry_id INTEGER PRIMARY KEY,
          entry_key BLOB NOT NULL,
          value BLOB NOT NULL
        );

        CREATE TABLE IF NOT EXISTS trash (
          entry_id INTEGER PRIMARY KEY REFERENCES entries(entry_id) ON DELETE CASCADE,
          deleted_at TEXT NOT NULL
        );
        ",
    )?;
    Ok(())
}

pub fn get_vault_info(conn: &Connection, key: &str) -> Result<Option<String>> {
    let value = conn
        .query_row(
            "SELECT value FROM vault_info WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .optional()?;
    Ok(value)
}

pub fn set_vault_info(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO vault_info(key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

pub fn get_umk_blob(conn: &Connection) -> Result<Option<Vec<u8>>> {
    let value = conn
        .query_row(
            "SELECT value FROM key_store WHERE type = ?1 AND label IS NULL LIMIT 1",
            params![UMK_KEY_TYPE],
            |row| row.get(0),
        )
        .optional()?;
    Ok(value)
}

pub fn set_umk_blob(conn: &Connection, blob: &[u8], timestamp: &str) -> Result<()> {
    let changed = conn.execute(
        "UPDATE key_store
         SET value = ?1, rotated_at = ?2
         WHERE type = ?3 AND label IS NULL",
        params![blob, timestamp, UMK_KEY_TYPE],
    )?;

    if changed == 0 {
        conn.execute(
            "INSERT INTO key_store(type, label, value, created_at, rotated_at)
             VALUES (?1, NULL, ?2, ?3, NULL)",
            params![UMK_KEY_TYPE, blob, timestamp],
        )?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    use super::{create_schema, get_umk_blob, get_vault_info, set_umk_blob, set_vault_info};

    #[test]
    fn creates_schema_and_minimal_queries_work() {
        let conn = Connection::open_in_memory().expect("open sqlite");
        conn.pragma_update(None, "foreign_keys", "ON")
            .expect("enable foreign keys");

        create_schema(&conn).expect("create schema");

        let foreign_keys: i64 = conn
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
            .expect("read pragma");
        assert_eq!(foreign_keys, 1);

        set_vault_info(&conn, "username", "alice").expect("set vault info");
        let username = get_vault_info(&conn, "username").expect("query");
        assert_eq!(username.as_deref(), Some("alice"));

        set_umk_blob(&conn, &[9_u8; 196], "2026-02-28T12:00:00Z").expect("set umk");
        let umk = get_umk_blob(&conn).expect("query umk");
        assert_eq!(umk, Some(vec![9_u8; 196]));
    }
}
