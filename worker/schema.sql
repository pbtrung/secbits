PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS key_types (type TEXT PRIMARY KEY);
INSERT OR IGNORE INTO key_types (type) VALUES
  ('umk'), ('emergency'), ('own_public'), ('own_private'), ('peer_public');

CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS key_store (
  key_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(user_id),
  type TEXT NOT NULL REFERENCES key_types(type),
  label TEXT,
  encrypted_data BLOB,
  peer_user_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(user_id),
  entry_key BLOB NOT NULL,
  encrypted_data BLOB NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS entry_history (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES entries(id),
  encrypted_snapshot BLOB NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_key_store_user ON key_store(user_id);
CREATE INDEX IF NOT EXISTS idx_entries_user   ON entries(user_id);
CREATE INDEX IF NOT EXISTS idx_history_entry  ON entry_history(entry_id);
