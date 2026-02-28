use rusqlite::{Connection, OptionalExtension, params};

use crate::Result;

const UMK_KEY_TYPE: &str = "umk";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EntryRow {
    pub entry_id: i64,
    pub entry_key: Vec<u8>,
    pub value: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrashedEntryRow {
    pub entry: EntryRow,
    pub deleted_at: String,
}

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

pub fn insert_entry(conn: &Connection, entry_key: &[u8], value: &[u8]) -> Result<i64> {
    conn.execute(
        "INSERT INTO entries(entry_key, value) VALUES (?1, ?2)",
        params![entry_key, value],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn update_entry(conn: &Connection, entry_id: i64, entry_key: &[u8], value: &[u8]) -> Result<usize> {
    let affected = conn.execute(
        "UPDATE entries SET entry_key = ?1, value = ?2 WHERE entry_id = ?3",
        params![entry_key, value, entry_id],
    )?;
    Ok(affected)
}

pub fn get_entry(conn: &Connection, entry_id: i64) -> Result<Option<EntryRow>> {
    let row = conn
        .query_row(
            "SELECT entry_id, entry_key, value FROM entries WHERE entry_id = ?1",
            params![entry_id],
            |row| {
                Ok(EntryRow {
                    entry_id: row.get(0)?,
                    entry_key: row.get(1)?,
                    value: row.get(2)?,
                })
            },
        )
        .optional()?;
    Ok(row)
}

pub fn list_active_entries(conn: &Connection) -> Result<Vec<EntryRow>> {
    let mut stmt = conn.prepare(
        "SELECT e.entry_id, e.entry_key, e.value
         FROM entries e
         LEFT JOIN trash t ON t.entry_id = e.entry_id
         WHERE t.entry_id IS NULL
         ORDER BY e.entry_id ASC",
    )?;

    let rows = stmt
        .query_map([], |row| {
            Ok(EntryRow {
                entry_id: row.get(0)?,
                entry_key: row.get(1)?,
                value: row.get(2)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;

    Ok(rows)
}

pub fn get_active_entry(conn: &Connection, entry_id: i64) -> Result<Option<EntryRow>> {
    let row = conn
        .query_row(
            "SELECT e.entry_id, e.entry_key, e.value
             FROM entries e
             LEFT JOIN trash t ON t.entry_id = e.entry_id
             WHERE e.entry_id = ?1 AND t.entry_id IS NULL",
            params![entry_id],
            |row| {
                Ok(EntryRow {
                    entry_id: row.get(0)?,
                    entry_key: row.get(1)?,
                    value: row.get(2)?,
                })
            },
        )
        .optional()?;
    Ok(row)
}

pub fn set_entry_deleted(conn: &Connection, entry_id: i64, deleted_at: &str) -> Result<usize> {
    let affected = conn.execute(
        "INSERT INTO trash(entry_id, deleted_at) VALUES (?1, ?2)
         ON CONFLICT(entry_id) DO UPDATE SET deleted_at = excluded.deleted_at",
        params![entry_id, deleted_at],
    )?;
    Ok(affected)
}

pub fn clear_entry_deleted(conn: &Connection, entry_id: i64) -> Result<usize> {
    let affected = conn.execute("DELETE FROM trash WHERE entry_id = ?1", params![entry_id])?;
    Ok(affected)
}

pub fn delete_entry(conn: &Connection, entry_id: i64) -> Result<usize> {
    let affected = conn.execute("DELETE FROM entries WHERE entry_id = ?1", params![entry_id])?;
    Ok(affected)
}

pub fn is_entry_trashed(conn: &Connection, entry_id: i64) -> Result<bool> {
    let exists = conn
        .query_row(
            "SELECT 1 FROM trash WHERE entry_id = ?1",
            params![entry_id],
            |_row| Ok(()),
        )
        .optional()?
        .is_some();
    Ok(exists)
}

pub fn get_trashed_entry(conn: &Connection, entry_id: i64) -> Result<Option<TrashedEntryRow>> {
    let row = conn
        .query_row(
            "SELECT e.entry_id, e.entry_key, e.value, t.deleted_at
             FROM entries e
             JOIN trash t ON t.entry_id = e.entry_id
             WHERE e.entry_id = ?1",
            params![entry_id],
            |row| {
                Ok(TrashedEntryRow {
                    entry: EntryRow {
                        entry_id: row.get(0)?,
                        entry_key: row.get(1)?,
                        value: row.get(2)?,
                    },
                    deleted_at: row.get(3)?,
                })
            },
        )
        .optional()?;
    Ok(row)
}

pub fn list_trashed_entries(conn: &Connection) -> Result<Vec<TrashedEntryRow>> {
    let mut stmt = conn.prepare(
        "SELECT e.entry_id, e.entry_key, e.value, t.deleted_at
         FROM entries e
         JOIN trash t ON t.entry_id = e.entry_id
         ORDER BY t.deleted_at DESC, e.entry_id ASC",
    )?;

    let rows = stmt
        .query_map([], |row| {
            Ok(TrashedEntryRow {
                entry: EntryRow {
                    entry_id: row.get(0)?,
                    entry_key: row.get(1)?,
                    value: row.get(2)?,
                },
                deleted_at: row.get(3)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;

    Ok(rows)
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    use super::{
        clear_entry_deleted, create_schema, get_active_entry, get_entry, get_trashed_entry,
        get_umk_blob, get_vault_info, insert_entry, is_entry_trashed, list_active_entries,
        list_trashed_entries, set_entry_deleted, set_umk_blob, set_vault_info,
    };

    fn setup_conn() -> Connection {
        let conn = Connection::open_in_memory().expect("open sqlite");
        conn.pragma_update(None, "foreign_keys", "ON")
            .expect("enable foreign keys");
        create_schema(&conn).expect("create schema");
        conn
    }

    #[test]
    fn creates_schema_and_minimal_queries_work() {
        let conn = setup_conn();

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

    #[test]
    fn entries_and_trash_queries_work() {
        let conn = setup_conn();
        let id = insert_entry(&conn, b"entry-key", b"value").expect("insert entry");

        let row = get_entry(&conn, id).expect("get entry").expect("row exists");
        assert_eq!(row.entry_id, id);

        let active_before = list_active_entries(&conn).expect("list active");
        assert_eq!(active_before.len(), 1);

        set_entry_deleted(&conn, id, "2026-02-28T12:10:00Z").expect("trash entry");
        assert!(is_entry_trashed(&conn, id).expect("is trashed"));
        assert!(get_active_entry(&conn, id).expect("active lookup").is_none());

        let trash = get_trashed_entry(&conn, id).expect("get trashed").expect("exists");
        assert_eq!(trash.entry.entry_id, id);
        assert_eq!(trash.deleted_at, "2026-02-28T12:10:00Z");

        let trash_list = list_trashed_entries(&conn).expect("list trashed");
        assert_eq!(trash_list.len(), 1);

        clear_entry_deleted(&conn, id).expect("restore");
        assert!(!is_entry_trashed(&conn, id).expect("is trashed"));
        assert!(get_active_entry(&conn, id).expect("active lookup").is_some());
    }
}
