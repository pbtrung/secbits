# Data Model

## SQLite Schema

### users

```sql
CREATE TABLE users (
  user_id          INTEGER PRIMARY KEY,
  username         TEXT UNIQUE NOT NULL,
  user_master_key  BLOB NOT NULL   -- encryptBytesToBlob(root_master_key, umk)
);
```

One row per vault user. `user_master_key` is a 192-byte encrypted blob (see
`design/crypto.md`).

### entries

```sql
CREATE TABLE entries (
  entry_id    INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(user_id),
  path_hint   TEXT NOT NULL UNIQUE,  -- e.g. "mail/google/main"
  type        TEXT NOT NULL,         -- "login" | "note" | "card"
  deleted_at  TEXT,                  -- ISO 8601 if in trash, NULL otherwise
  entry_key   BLOB NOT NULL,         -- encryptBytesToBlob(umk, doc_key)
  value       BLOB NOT NULL          -- encryptBytesToBlob(doc_key, brotli(JSON(history)))
);
```

`path_hint` is the display/address key. `entry_key` is 192 bytes
(encrypted 64-byte doc key). `value` is variable-length (encrypted, compressed
history JSON).

## Entry Types

Three types, set at creation, immutable afterward:

| Type | Fields |
|------|--------|
| `"login"` | title, username, password, notes, urls, totpSecrets, customFields, tags |
| `"note"` | title, notes, tags |
| `"card"` | title, cardholderName, cardNumber, expiry, cvv, notes, tags |

## EntrySnapshot

The current (or historical) state of one entry:

```json
{
  "title":         "string (required)",
  "username":      "string",
  "password":      "string",
  "cardholderName":"string",
  "cardNumber":    "string",
  "expiry":        "string (MM/YY)",
  "cvv":           "string",
  "notes":         "string",
  "urls":          ["string"],
  "totpSecrets":   ["string"],
  "customFields":  [{ "id": 1, "label": "string", "value": "string" }],
  "tags":          ["string"],
  "timestamp":     "ISO 8601"
}
```

Fields not relevant to the entry type are absent or empty. Change detection
operates on: `title`, `username`, `password`, `cardholderName`, `cardNumber`,
`expiry`, `cvv`, `notes`, `urls`, `totpSecrets`, `customFields`, `tags`.

## History Object

Stored (encrypted + compressed) in `entries.value`:

```json
{
  "head":          "a1b2c3d4e5f6",
  "head_snapshot": { "...": "..." },
  "commits": [
    {
      "hash":      "a1b2c3d4e5f6",
      "parent":    "f7e8d9c0b1a2",
      "timestamp": "2026-02-28T14:30:00Z",
      "changed":   ["password"],
      "delta":     null
    },
    {
      "hash":      "f7e8d9c0b1a2",
      "parent":    null,
      "timestamp": "2026-02-28T12:00:00Z",
      "changed":   ["title", "password"],
      "delta": {
        "set":   { "title": "old title", "password": "old pass" },
        "unset": []
      }
    }
  ]
}
```

### Commit Rules

1. `commits[0]` is HEAD. `delta` is always `null` for HEAD; current state is
   read directly from `head_snapshot`.
2. Commits at index 1+ carry `delta.set` (field values at that commit) and
   `delta.unset` (fields that were absent/empty).
3. The oldest commit (`parent: null`) always carries a full-snapshot delta:
   all fields set to their values at that commit. This is the reconstruction
   baseline.
4. Max commits = 20. On overflow: drop oldest (FIFO), reconstruct full snapshot
   at new oldest, update its `delta.set`.

### Commit Hash

`SHA-256(content_json_without_timestamp)`, first 12 hex characters. Computed
by `content_hash()` in `model.rs`.

### Dedup

If `content_hash(new_snapshot) == history.head`, the save is a no-op; no
commit is appended.

### Semantic Diff (normalize_for_compare)

| Field | Normalization |
|-------|--------------|
| `tags` | case-insensitive set comparison |
| `urls` | lowercase + strip trailing slash, set comparison |
| `totpSecrets` | set comparison |
| `customFields` | matched by `id`, not array index |
| All others | direct string equality |

## Trash (Soft Delete)

Deleting an entry sets `deleted_at` to the current ISO 8601 timestamp. The row
stays in the database. The history object is preserved intact.

Trash operations:
- **Restore**: clear `deleted_at`.
- **Purge** (permanent delete): `DELETE` the row.

Trash entries are excluded from the main entry list and search but are returned
by a separate `list_trash` command/query.

## Restore Flow

`restore_to_commit(history, hash)`:
1. If `hash == history.head`, return early; already at target.
2. Reconstruct the target snapshot by applying deltas backward from `head_snapshot`.
3. Call `append_snapshot(history, reconstructed)` with a fresh timestamp.
4. Dedup check: if reconstructed content hash == current head, no commit is appended.

## Export Format

`export_vault()` returns a JSON object:

```json
{
  "version": 1,
  "username": "alice",
  "data": [
    {
      "id":           "path_hint string",
      "type":         "login",
      "title":        "Gmail",
      "username":     "alice@gmail.com",
      "password":     "...",
      "notes":        "",
      "urls":         ["https://mail.google.com"],
      "totpSecrets":  [],
      "customFields": [],
      "tags":         ["email"],
      "_commits": [
        { "hash": "...", "timestamp": "...", "changed": ["password"] }
      ]
    }
  ],
  "trash": [
    {
      "id":        "...",
      "type":      "login",
      "title":     "Old entry",
      "deletedAt": "2026-02-28T10:00:00Z",
      "...":       "..."
    }
  ]
}
```

`id` is the `path_hint`. `_commits` is the linearized commit list without deltas.
The export is plaintext JSON; not encrypted. A warning is shown before export.
