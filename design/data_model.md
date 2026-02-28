# Data Model

## SQLite Schema

### vault_info

```sql
CREATE TABLE vault_info (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
```

Single-row-per-key config store. Populated on `init_vault`.

| key | value |
|-----|-------|
| `username` | display name |
| `created_at` | ISO 8601 |
| `schema_version` | integer string |

### key_store

```sql
CREATE TABLE key_store (
  key_id     INTEGER PRIMARY KEY,
  type       TEXT NOT NULL,
  label      TEXT,
  value      BLOB NOT NULL,
  created_at TEXT NOT NULL,
  rotated_at TEXT
);
```

All key material lives here. `type` is a discriminant string backed by a Rust
enum (`KeyType`); business logic never does ad-hoc string comparisons.

| type | label | value | count |
|------|-------|-------|-------|
| `umk` | NULL | `encrypt(root_master_key, user_master_key)` | 1 |
| `identity_sk` | NULL | `encrypt(umk, ml_kem_x448_secret_key)` | 0 or 1 |
| `identity_pk` | NULL | raw ML-KEM-1024+X448 public key bytes | 0 or 1 |
| `contact_pk` | their username | raw public key bytes | 0..N |
| `emergency` | contact name | `encrypt(contact_pk, umk_copy)` | 0..N |

`rotated_at` is NULL until the key is replaced; kept for audit purposes.

#### Key lookup for entry encryption/decryption

```
init:
  row = SELECT value FROM key_store WHERE type = 'umk'
  umk = decrypt(root_master_key, row.value)        -- held in AppState

per-entry read:
  row = SELECT entry_key, value FROM entries WHERE entry_id = ?
  doc_key = decrypt(umk, row.entry_key)
  history = decompress(decrypt(doc_key, row.value))

per-entry write:
  doc_key = random_bytes(64)                       -- fresh per entry
  entry_key = encrypt(umk, doc_key)
  value = encrypt(doc_key, compress(json(history)))
```

No `key_id` is needed in `entries`. There is always exactly one active UMK row
(`WHERE type='umk'`). Root key rotation re-wraps the UMK blob but does not
change the UMK bytes themselves, so `entry_key` blobs are unaffected.

### entries

```sql
CREATE TABLE entries (
  entry_id  INTEGER PRIMARY KEY,
  entry_key BLOB NOT NULL,   -- encrypt(umk, doc_key)
  value     BLOB NOT NULL    -- encrypt(doc_key, brotli(json(history)))
);
```

No plaintext metadata columns. All entry data (type, title, path, tags, fields)
lives inside the encrypted `value`. On unlock the full list is decrypted into
memory; this is the standard approach for personal vaults.

### trash

```sql
CREATE TABLE trash (
  entry_id   INTEGER PRIMARY KEY REFERENCES entries(entry_id),
  deleted_at TEXT NOT NULL   -- ISO 8601
);
```

Soft delete: entry row stays in `entries`; a row is inserted here.
- **Restore**: delete the `trash` row.
- **Purge**: delete the `trash` row then the `entries` row.

Active entries: `SELECT * FROM entries WHERE entry_id NOT IN (SELECT entry_id FROM trash)`.
Trashed entries: `SELECT e.* FROM entries e JOIN trash t ON e.entry_id = t.entry_id`.

## Encrypted Value: History Object

The JSON stored inside `entries.value` (after decrypt + decompress):

```json
{
  "type": "login",
  "head": "a1b2c3d4e5f6",
  "head_snapshot": {
    "title":        "Gmail",
    "username":     "alice@gmail.com",
    "password":     "...",
    "notes":        "",
    "urls":         ["https://mail.google.com"],
    "totpSecrets":  [],
    "customFields": [],
    "tags":         ["email"],
    "timestamp":    "2026-02-28T14:30:00Z"
  },
  "commits": [
    {
      "hash":      "a1b2c3d4e5f6",
      "parent":    null,
      "timestamp": "2026-02-28T14:30:00Z",
      "changed":   ["title", "username", "password"],
      "delta":     null
    }
  ]
}
```

`type` is at the history object level because it is immutable (set at creation,
never changed). It is not duplicated inside snapshots or deltas.

## Entry Types

Three types, fixed at creation:

| type | fields in snapshot |
|------|--------------------|
| `"login"` | title, username, password, notes, urls, totpSecrets, customFields, tags |
| `"note"` | title, notes, tags |
| `"card"` | title, cardholderName, cardNumber, expiry, cvv, notes, tags |

## EntrySnapshot Fields

```json
{
  "title":          "string (required)",
  "username":       "string",
  "password":       "string",
  "cardholderName": "string",
  "cardNumber":     "string",
  "expiry":         "string (MM/YY)",
  "cvv":            "string",
  "notes":          "string",
  "urls":           ["string"],
  "totpSecrets":    ["string"],
  "customFields":   [{ "id": 1, "label": "string", "value": "string" }],
  "tags":           ["string"],
  "timestamp":      "ISO 8601"
}
```

Fields absent from a snapshot are treated as empty. Change detection operates on
all fields except `timestamp`.

## Commit Rules

1. `commits[0]` is HEAD. `delta` is always `null` for HEAD; current state is
   read directly from `head_snapshot`.
2. Commits at index 1+ carry `delta.set` (field values at that commit) and
   `delta.unset` (fields that were absent/empty at that commit).
3. The oldest commit (`parent: null`) always carries a full-snapshot delta:
   all fields set to their values at that commit. This is the reconstruction
   baseline.
4. Max commits = 20. On overflow: drop oldest (FIFO), reconstruct full snapshot
   at new oldest, update its `delta.set`.

### Commit Hash

`SHA-256(content_json_without_timestamp)`, first 12 hex characters.

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

## Restore Flow

`restore_to_commit(history, hash)`:
1. If `hash == history.head`, return early; already at target.
2. Reconstruct the target snapshot by applying deltas backward from `head_snapshot`.
3. Call `append_snapshot(history, reconstructed)` with a fresh timestamp.
4. Dedup check: if reconstructed content hash equals current head, no commit appended.

## Export Format

`export_vault()` returns plaintext JSON (a warning is shown before calling):

```json
{
  "version": 1,
  "username": "alice",
  "data": [
    {
      "id":           1,
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
      "id":        2,
      "type":      "login",
      "title":     "Old entry",
      "deletedAt": "2026-02-28T10:00:00Z"
    }
  ]
}
```

`id` is `entry_id`. `_commits` is the linearized commit list without delta values.
