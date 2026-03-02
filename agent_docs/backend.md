# Backend

Cloudflare Worker + rqlite.

```
Browser -> Worker -> rqlite
```

Authentication: Firebase ID token (`Authorization: Bearer <token>`). The Worker verifies the token on every request and derives a stable `user_id` from the Firebase UID. All routes except `/health` require a valid token.

The Worker holds rqlite credentials as secrets and communicates with rqlite over HTTP using Basic Auth. The browser has no knowledge of rqlite credentials.

## Identity Derivation

```
user_id = z-base-32(SHA3-256(firebase_uid))
```

SHA3-256 of the Firebase UID produces 32 bytes (256 bits). z-base-32 encodes them as a 52-character string using the alphabet `ybndrfg8ejkmcpqxot1uwisza345h769`. The `user_id` is the sole database key for all user-scoped queries; no separate namespace identifier is needed.

On the first authenticated request the Worker upserts a row into `users` to register the account.

## ID Generation

| Identifier | Scheme |
|------------|--------|
| `user_id` | z-base-32(SHA3-256(firebase_uid)) — 52 characters |
| `entries.id` | z-base-32(random 192 bits) — 39 characters |
| `entry_history.id` | z-base-32(random 192 bits) — 39 characters |
| `key_store.key_id` | z-base-32(random 192 bits) — 39 characters |
| `commit_hash` | z-base-32(SHA3-256(plaintext snapshot JSON)) — 52 characters |

IDs for entries, history, and keys are generated in the browser using `crypto.getRandomValues` and encoded with z-base-32 before being sent to the Worker.

## rqlite Schema

```sql
CREATE TABLE IF NOT EXISTS users (
  user_id    TEXT PRIMARY KEY,  -- z-base-32(SHA3-256(firebase_uid))
  created_at TEXT NOT NULL      -- ISO 8601
);

CREATE TABLE IF NOT EXISTS key_store (
  key_id         TEXT PRIMARY KEY,  -- z-base-32(random 192 bits)
  user_id        TEXT NOT NULL REFERENCES users(user_id),
  type           TEXT NOT NULL,     -- see key types below
  label          TEXT,              -- optional human-readable name
  encrypted_data BLOB,             -- key material; see type notes below
  peer_user_id   TEXT,             -- for "peer_public": source user's user_id
  created_at     TEXT NOT NULL      -- ISO 8601
);

CREATE TABLE IF NOT EXISTS entries (
  id             TEXT PRIMARY KEY,  -- z-base-32(random 192 bits)
  user_id        TEXT NOT NULL REFERENCES users(user_id),
  type           TEXT NOT NULL,     -- "login" | "note" | "card"
  encrypted_data BLOB NOT NULL,    -- encrypted entry blob
  created_at     TEXT NOT NULL,     -- ISO 8601
  updated_at     TEXT NOT NULL,     -- ISO 8601
  deleted_at     TEXT              -- NULL = live, non-NULL = trashed (ISO 8601)
);

CREATE TABLE IF NOT EXISTS entry_history (
  id                 TEXT PRIMARY KEY,  -- z-base-32(random 192 bits)
  entry_id           TEXT NOT NULL REFERENCES entries(id),
  commit_hash        TEXT NOT NULL,     -- z-base-32(SHA3-256(plaintext snapshot JSON))
  encrypted_snapshot BLOB NOT NULL,    -- encrypted snapshot blob
  created_at         TEXT NOT NULL      -- ISO 8601
);

CREATE INDEX IF NOT EXISTS idx_key_store_user  ON key_store(user_id);
CREATE INDEX IF NOT EXISTS idx_entries_user    ON entries(user_id);
CREATE INDEX IF NOT EXISTS idx_history_entry   ON entry_history(entry_id);
```

### Key Types

| Type | Count | `encrypted_data` content |
|------|-------|--------------------------|
| `umk` | one per user | user master key bytes, encrypted with root_master_key (HKDF + AEAD) |
| `emergency` | multiple | emergency access key bytes, independently encrypted |
| `own_public` | one per user | raw public key bytes (unencrypted) |
| `own_private` | one per user | private key bytes encrypted with the UMK |
| `peer_public` | one per sharing partner | raw public key bytes from another user (unencrypted); `peer_user_id` identifies the source user |

`encrypted_data` is NULL only for `own_public` and `peer_public` rows when the public key is stored separately, but the preferred layout is to store all byte payloads in `encrypted_data` regardless of whether they are encrypted.

`encrypted_data` and `encrypted_snapshot` in `entries` and `entry_history` are opaque blobs in the format `magic(7) || version(2) || salt(64) || ciphertext(var) || tag(64)`. The Worker stores and returns them without decrypting them.

In the rqlite HTTP API, BLOB columns are passed and received as base64-encoded strings within JSON payloads. The Worker base64-encodes blobs before sending them to rqlite and base64-decodes them on retrieval. The Worker's API responses to the browser carry BLOB fields as base64 strings.

## Worker API

| Method | Path | Purpose |
|--------|------|---------|
| `GET`    | `/entries`                    | List all live entries for the authenticated user |
| `GET`    | `/entries/trash`              | List all trashed entries for the authenticated user |
| `POST`   | `/entries`                    | Create a new entry |
| `PUT`    | `/entries/:id`                | Update an existing entry |
| `DELETE` | `/entries/:id`                | Soft delete (set deleted_at) |
| `POST`   | `/entries/:id/restore`        | Restore a trashed entry |
| `DELETE` | `/entries/:id/purge`          | Permanently delete an entry and its history |
| `GET`    | `/entries/:id/history`        | List history commits for an entry |
| `GET`    | `/keys`                       | List key metadata for the authenticated user |
| `POST`   | `/keys`                       | Add a key record |
| `GET`    | `/keys/:key_id`               | Get a key record including encrypted_data |
| `DELETE` | `/keys/:key_id`               | Delete a key record |
| `GET`    | `/users/:user_id/public-key`  | Get another user's own_public key |
| `GET`    | `/health`                     | Health check (no auth required) |

All routes except `/health` and `GET /users/:user_id/public-key` are scoped to the authenticated user's `user_id`. No client-supplied user identifier is trusted; the Worker derives `user_id` from the verified Firebase token on every request.

All request and response bodies use `Content-Type: application/json`.

## Route Details

### GET /entries

Response `200`:
```json
[
  {
    "id": "<z-base-32>",
    "type": "login",
    "encrypted_data": "<base64>",
    "created_at": "2026-01-01T00:00:00.000Z",
    "updated_at": "2026-01-01T00:00:00.000Z"
  }
]
```

### GET /entries/trash

Response `200`: same shape as `GET /entries`; entries have non-null `deleted_at` included in each object.

### POST /entries

Request body:
```json
{
  "id": "<z-base-32(random 192 bits)>",
  "type": "login",
  "encrypted_data": "<base64>"
}
```

Response `201`:
```json
{ "id": "<z-base-32>", "created_at": "2026-01-01T00:00:00.000Z" }
```

Also inserts an `entry_history` row with the same `encrypted_data` as the initial snapshot.

### PUT /entries/:id

Request body:
```json
{
  "encrypted_data": "<base64>",
  "commit_id": "<z-base-32(random 192 bits)>",
  "commit_hash": "<z-base-32(SHA3-256(plaintext))>"
}
```

Response `200`:
```json
{ "id": "<z-base-32>", "updated_at": "2026-01-01T00:00:00.000Z" }
```

Also appends an `entry_history` row. If the entry already has 20 commits, the oldest commit row is deleted before the new one is inserted.

### DELETE /entries/:id

Sets `deleted_at` to the current UTC timestamp. History is preserved.

Response `200`:
```json
{ "id": "<z-base-32>", "deleted_at": "2026-01-01T00:00:00.000Z" }
```

### POST /entries/:id/restore

Sets `deleted_at` to NULL.

Response `200`:
```json
{ "id": "<z-base-32>" }
```

### DELETE /entries/:id/purge

Deletes all `entry_history` rows for the entry, then deletes the entry row.

Response `200`:
```json
{ "id": "<z-base-32>" }
```

### GET /entries/:id/history

Response `200` (ordered by `created_at` descending):
```json
[
  {
    "id": "<z-base-32>",
    "entry_id": "<z-base-32>",
    "commit_hash": "<z-base-32>",
    "encrypted_snapshot": "<base64>",
    "created_at": "2026-01-01T00:00:00.000Z"
  }
]
```

### GET /keys

Returns key metadata only; `encrypted_data` is not included in list responses.

Response `200`:
```json
[
  {
    "key_id": "<z-base-32>",
    "type": "umk",
    "label": null,
    "peer_user_id": null,
    "created_at": "2026-01-01T00:00:00.000Z"
  }
]
```

### POST /keys

Request body:
```json
{
  "key_id": "<z-base-32(random 192 bits)>",
  "type": "umk",
  "label": "optional label",
  "encrypted_data": "<base64>",
  "peer_user_id": null
}
```

Response `201`:
```json
{ "key_id": "<z-base-32>", "created_at": "2026-01-01T00:00:00.000Z" }
```

### GET /keys/:key_id

Returns the full key record including `encrypted_data`.

Response `200`:
```json
{
  "key_id": "<z-base-32>",
  "type": "umk",
  "label": null,
  "encrypted_data": "<base64>",
  "peer_user_id": null,
  "created_at": "2026-01-01T00:00:00.000Z"
}
```

### DELETE /keys/:key_id

Deletes the key record. The Worker enforces that the record belongs to the authenticated user before deleting.

Response `200`:
```json
{ "key_id": "<z-base-32>" }
```

### GET /users/:user_id/public-key

Returns the `own_public` key record for the specified user. Used to obtain another user's public key before encrypting a shared entry.

Response `200`:
```json
{
  "user_id": "<z-base-32>",
  "encrypted_data": "<base64>"
}
```

Response `404` if the user has no `own_public` key record.

## rqlite HTTP API

The Worker communicates with rqlite using two endpoints:

| Endpoint | Purpose |
|----------|---------|
| `POST /db/query` | Read queries (SELECT) |
| `POST /db/execute` | Write queries (INSERT, UPDATE, DELETE) |

Every request to rqlite carries `Authorization: Basic <base64(username:password)>` using the `RQLITE_URL`, `RQLITE_USERNAME`, and `RQLITE_PASSWORD` Worker secrets.

Parameterized query format (array of `[sql, ...params]`):

```json
[["SELECT id, type, encrypted_data, created_at, updated_at FROM entries WHERE user_id = ? AND deleted_at IS NULL", "<user_id>"]]
```

BLOB parameters are passed as base64-encoded strings in the JSON array. rqlite maps them to SQLite BLOB storage.

rqlite response format for reads:

```json
{
  "results": [
    {
      "columns": ["id", "type", "encrypted_data", "created_at", "updated_at"],
      "types":   ["text", "text", "blob", "text", "text"],
      "values":  [["<z-base-32>", "login", "<base64>", "...", "..."]]
    }
  ]
}
```

rqlite response format for writes:

```json
{
  "results": [
    { "rows_affected": 1, "last_insert_id": 0 }
  ]
}
```

## Worker Secrets

| Secret | Purpose |
|--------|---------|
| `FIREBASE_PROJECT_ID` | Validates the `aud` claim in Firebase ID tokens |
| `RQLITE_URL` | Base URL of the rqlite HTTP API |
| `RQLITE_USERNAME` | rqlite Basic Auth username |
| `RQLITE_PASSWORD` | rqlite Basic Auth password |

## Input Validation

The Worker validates all inputs before constructing SQL parameters:

- `id`, `key_id`, `commit_id`: required, valid z-base-32 string, 39 characters.
- `type` (entry): must be one of `"login"`, `"note"`, `"card"`.
- `type` (key): must be one of `"umk"`, `"emergency"`, `"own_public"`, `"own_private"`, `"peer_public"`.
- `encrypted_data` / `encrypted_snapshot`: required where applicable; valid base64 string; minimum 137 bytes when decoded (minimum valid blob length).
- `peer_user_id`: required when `type` is `"peer_public"`; valid z-base-32 string, 52 characters; must not equal the authenticated user's own `user_id`.
- `:id` and `:key_id` path parameters: valid z-base-32 strings of the expected length.
- `commit_hash`: valid z-base-32 string, 52 characters.
- The Worker enforces that `:id` and `:key_id` path parameters resolve to rows owned by the authenticated user before executing any write or delete.

All SQL queries use parameterized statements. No string interpolation is used to construct SQL.
