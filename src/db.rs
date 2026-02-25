use std::path::Path;

use rusqlite::{params, Connection};

use crate::error::AppError;
use crate::Result;

const SCHEMA_VERSION: i64 = 1;

#[derive(Debug)]
pub struct Database {
    conn: Connection,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserRecord {
    pub user_id: i64,
    pub username: String,
    pub user_master_key: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EntryRecord {
    pub entry_id: i64,
    pub user_id: i64,
    pub path_hint: String,
    pub entry_key: Vec<u8>,
    pub value: Vec<u8>,
}

impl Database {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let conn = Connection::open(path)?;
        Self::initialize(conn)
    }

    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        Self::initialize(conn)
    }

    fn initialize(conn: Connection) -> Result<Self> {
        conn.execute_batch("PRAGMA foreign_keys = ON;")?;
        init_schema(&conn)?;
        Ok(Self { conn })
    }

    pub fn user_version(&self) -> Result<i64> {
        let version = self
            .conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))?;
        Ok(version)
    }

    pub fn create_user(&self, username: &str, user_master_key: &[u8]) -> Result<i64> {
        self.conn.execute(
            "INSERT INTO users (username, user_master_key) VALUES (?1, ?2)",
            params![username, user_master_key],
        )?;

        Ok(self.conn.last_insert_rowid())
    }

    pub fn get_user_by_username(&self, username: &str) -> Result<Option<UserRecord>> {
        let mut stmt = self.conn.prepare(
            "SELECT user_id, username, user_master_key
             FROM users
             WHERE username = ?1",
        )?;

        let mut rows = stmt.query(params![username])?;
        if let Some(row) = rows.next()? {
            return Ok(Some(UserRecord {
                user_id: row.get(0)?,
                username: row.get(1)?,
                user_master_key: row.get(2)?,
            }));
        }

        Ok(None)
    }

    pub fn update_user_master_key(&self, user_id: i64, user_master_key: &[u8]) -> Result<usize> {
        let changed = self.conn.execute(
            "UPDATE users SET user_master_key = ?1 WHERE user_id = ?2",
            params![user_master_key, user_id],
        )?;

        Ok(changed)
    }

    pub fn delete_user(&self, user_id: i64) -> Result<usize> {
        let changed = self
            .conn
            .execute("DELETE FROM users WHERE user_id = ?1", params![user_id])?;

        Ok(changed)
    }

    pub fn create_entry(
        &self,
        user_id: i64,
        path_hint: &str,
        entry_key: &[u8],
        value: &[u8],
    ) -> Result<i64> {
        self.conn.execute(
            "INSERT INTO entries (user_id, path_hint, entry_key, value)
             VALUES (?1, ?2, ?3, ?4)",
            params![user_id, path_hint, entry_key, value],
        )?;

        Ok(self.conn.last_insert_rowid())
    }

    pub fn get_entry_by_path(&self, user_id: i64, path_hint: &str) -> Result<Option<EntryRecord>> {
        let mut stmt = self.conn.prepare(
            "SELECT entry_id, user_id, path_hint, entry_key, value
             FROM entries
             WHERE user_id = ?1 AND path_hint = ?2",
        )?;

        let mut rows = stmt.query(params![user_id, path_hint])?;
        if let Some(row) = rows.next()? {
            return Ok(Some(EntryRecord {
                entry_id: row.get(0)?,
                user_id: row.get(1)?,
                path_hint: row.get(2)?,
                entry_key: row.get(3)?,
                value: row.get(4)?,
            }));
        }

        Ok(None)
    }

    pub fn list_entries_for_user(&self, user_id: i64) -> Result<Vec<EntryRecord>> {
        let mut stmt = self.conn.prepare(
            "SELECT entry_id, user_id, path_hint, entry_key, value
             FROM entries
             WHERE user_id = ?1
             ORDER BY path_hint ASC",
        )?;

        let rows = stmt.query_map(params![user_id], |row| {
            Ok(EntryRecord {
                entry_id: row.get(0)?,
                user_id: row.get(1)?,
                path_hint: row.get(2)?,
                entry_key: row.get(3)?,
                value: row.get(4)?,
            })
        })?;

        let mut entries = Vec::new();
        for row in rows {
            entries.push(row?);
        }

        Ok(entries)
    }

    pub fn update_entry_value(&self, entry_id: i64, value: &[u8]) -> Result<usize> {
        let changed = self.conn.execute(
            "UPDATE entries SET value = ?1 WHERE entry_id = ?2",
            params![value, entry_id],
        )?;

        Ok(changed)
    }

    pub fn delete_entry_by_path(&self, user_id: i64, path_hint: &str) -> Result<usize> {
        let changed = self.conn.execute(
            "DELETE FROM entries WHERE user_id = ?1 AND path_hint = ?2",
            params![user_id, path_hint],
        )?;

        Ok(changed)
    }
}

fn init_schema(conn: &Connection) -> Result<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;

    if version > SCHEMA_VERSION {
        return Err(AppError::UnsupportedSchemaVersion(version));
    }

    if version < 1 {
        create_schema(conn)?;
    }

    Ok(())
}

fn create_schema(conn: &Connection) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS users (
            user_id              INTEGER PRIMARY KEY,
            user_master_key      BLOB NOT NULL,
            username             TEXT NOT NULL UNIQUE,
            share_public_key     BLOB,
            share_secret_key_enc BLOB
        );

        CREATE TABLE IF NOT EXISTS entries (
            entry_id  INTEGER PRIMARY KEY,
            user_id   INTEGER NOT NULL,
            path_hint TEXT NOT NULL,
            entry_key BLOB NOT NULL,
            value     BLOB NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
            UNIQUE(user_id, path_hint)
        );

        CREATE INDEX IF NOT EXISTS idx_entries_user_id ON entries(user_id);
        PRAGMA user_version = 1;
        ",
    )?;
    tx.commit()?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::Database;

    #[test]
    fn fresh_db_bootstraps_schema() {
        let dir = tempdir().expect("temp dir");
        let db_path = dir.path().join("secbits.db");

        let db = Database::open(&db_path).expect("db opens");

        assert_eq!(db.user_version().expect("user version"), 1);
    }

    #[test]
    fn user_crud_round_trip() {
        let db = Database::open_in_memory().expect("db opens");
        let original_key = vec![7_u8; 192];

        let user_id = db
            .create_user("alice", &original_key)
            .expect("user inserted");
        let mut user = db
            .get_user_by_username("alice")
            .expect("user queried")
            .expect("user exists");

        assert_eq!(user.user_id, user_id);
        assert_eq!(user.username, "alice");
        assert_eq!(user.user_master_key, original_key);

        let updated_key = vec![8_u8; 192];
        let updated = db
            .update_user_master_key(user_id, &updated_key)
            .expect("user updated");
        assert_eq!(updated, 1);

        user = db
            .get_user_by_username("alice")
            .expect("user queried")
            .expect("user exists");
        assert_eq!(user.user_master_key, updated_key);

        let deleted = db.delete_user(user_id).expect("user deleted");
        assert_eq!(deleted, 1);

        assert!(db
            .get_user_by_username("alice")
            .expect("user queried")
            .is_none());
    }

    #[test]
    fn entry_crud_round_trip_and_user_cascade_delete() {
        let db = Database::open_in_memory().expect("db opens");
        let user_id = db
            .create_user("alice", &[9_u8; 192])
            .expect("user inserted");

        let entry_id = db
            .create_entry(user_id, "mail/google/main", &[1_u8; 64], &[2_u8; 96])
            .expect("entry inserted");

        let entry = db
            .get_entry_by_path(user_id, "mail/google/main")
            .expect("entry queried")
            .expect("entry exists");
        assert_eq!(entry.entry_id, entry_id);
        assert_eq!(entry.path_hint, "mail/google/main");

        let changed = db
            .update_entry_value(entry_id, &[3_u8; 111])
            .expect("entry updated");
        assert_eq!(changed, 1);

        let entry = db
            .get_entry_by_path(user_id, "mail/google/main")
            .expect("entry queried")
            .expect("entry exists");
        assert_eq!(entry.value, vec![3_u8; 111]);

        let entries = db
            .list_entries_for_user(user_id)
            .expect("entries listed for user");
        assert_eq!(entries.len(), 1);

        db.delete_user(user_id).expect("user deleted");

        assert!(db
            .get_entry_by_path(user_id, "mail/google/main")
            .expect("entry queried")
            .is_none());
    }

    #[test]
    fn delete_entry_by_path_works() {
        let db = Database::open_in_memory().expect("db opens");
        let user_id = db
            .create_user("alice", &[9_u8; 192])
            .expect("user inserted");
        db.create_entry(user_id, "mail/google/main", &[1_u8; 64], &[2_u8; 96])
            .expect("entry inserted");

        let deleted = db
            .delete_entry_by_path(user_id, "mail/google/main")
            .expect("entry deleted");
        assert_eq!(deleted, 1);

        assert!(db
            .get_entry_by_path(user_id, "mail/google/main")
            .expect("entry queried")
            .is_none());
    }
}
