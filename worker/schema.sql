CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,               -- Firebase UID (token.sub)
  username        TEXT NOT NULL DEFAULT '',
  user_master_key BLOB,                           -- 192 bytes; NULL until first login
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS entries (
  id         TEXT PRIMARY KEY,                    -- 42-char random a-zA-Z0-9
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entry_key  BLOB NOT NULL,                       -- ~192 bytes wrapped key
  value      BLOB NOT NULL CHECK(length(value) < 1900000),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_entries_user_id ON entries(user_id);
