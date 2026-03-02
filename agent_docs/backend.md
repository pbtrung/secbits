# Backend

Cloudflare Worker + rqlite.

```
Browser -> Worker -> rqlite
```

Authentication: Firebase ID token (`Authorization: Bearer <token>`). The Worker verifies the token on every request. All routes except `/health` require a valid token.

The Worker holds rqlite credentials as secrets and communicates with rqlite over HTTP using Basic Auth. The browser has no knowledge of rqlite credentials.

## rqlite Schema

```sql
CREATE TABLE IF NOT EXISTS entries (
  id           TEXT PRIMARY KEY,
  vault_id     TEXT NOT NULL,
  type         TEXT NOT NULL,
  encrypted_data TEXT NOT NULL,   -- base64-encoded encrypted blob
  created_at   TEXT NOT NULL,     -- ISO 8601
  updated_at   TEXT NOT NULL,     -- ISO 8601
  deleted_at   TEXT               -- NULL = live, non-NULL = in trash (ISO 8601)
);

CREATE TABLE IF NOT EXISTS entry_history (
  id                 TEXT PRIMARY KEY,   -- UUID
  entry_id           TEXT NOT NULL,
  commit_hash        TEXT NOT NULL,      -- 32-hex-char SHA-256 truncation of plaintext
  encrypted_snapshot TEXT NOT NULL,      -- base64-encoded encrypted blob
  created_at         TEXT NOT NULL       -- ISO 8601
);

CREATE INDEX IF NOT EXISTS idx_entries_vault   ON entries(vault_id);
CREATE INDEX IF NOT EXISTS idx_history_entry   ON entry_history(entry_id);
```

`encrypted_data` and `encrypted_snapshot` are base64-encoded blobs of the format `magic(7) || version(2) || salt(64) || ciphertext(var) || tag(64)`. The Worker stores and returns them as opaque strings; it never decrypts them.

## Worker API

| Method | Path | Purpose |
|--------|------|---------|
| `GET`    | `/entries`             | List all live entries for the vault |
| `GET`    | `/entries/trash`       | List all trashed entries for the vault |
| `POST`   | `/entries`             | Create a new entry |
| `PUT`    | `/entries/:id`         | Update an existing entry |
| `DELETE` | `/entries/:id`         | Soft delete (set deleted_at) |
| `POST`   | `/entries/:id/restore` | Restore a trashed entry |
| `DELETE` | `/entries/:id/purge`   | Permanently delete an entry and its history |
| `GET`    | `/entries/:id/history` | List history commits for an entry |
| `GET`    | `/health`              | Health check (no auth required) |

All vault routes require `Authorization: Bearer <firebase-id-token>`.

All request and response bodies use `Content-Type: application/json`.

The `vault_id` claim comes from the validated config sent in request bodies or query parameters. The Worker enforces that queries are scoped to the authenticated user's `vault_id`.

## Route Details

### GET /entries

Query parameter: `vault_id` (required).

Response `200`:
```json
[
  {
    "id": "uuid",
    "vault_id": "...",
    "type": "login",
    "encrypted_data": "<base64 blob>",
    "created_at": "2026-01-01T00:00:00.000Z",
    "updated_at": "2026-01-01T00:00:00.000Z"
  }
]
```

### GET /entries/trash

Query parameter: `vault_id` (required).

Response `200`: same shape as `GET /entries`, entries have non-null `deleted_at`.

### POST /entries

Request body:
```json
{
  "id": "uuid",
  "vault_id": "...",
  "type": "login",
  "encrypted_data": "<base64 blob>"
}
```

Response `201`:
```json
{ "id": "uuid", "created_at": "2026-01-01T00:00:00.000Z" }
```

Also inserts a history commit row with the same `encrypted_data` as the initial snapshot.

### PUT /entries/:id

Request body:
```json
{
  "vault_id": "...",
  "encrypted_data": "<base64 blob>"
}
```

Response `200`:
```json
{ "id": "uuid", "updated_at": "2026-01-01T00:00:00.000Z" }
```

Also appends a history commit row. If the entry already has 20 commits, the oldest commit is deleted before the new one is inserted.

### DELETE /entries/:id

Request body:
```json
{ "vault_id": "..." }
```

Sets `deleted_at` to the current UTC timestamp. Entry remains in the `entries` table. History is preserved.

Response `200`:
```json
{ "id": "uuid", "deleted_at": "2026-01-01T00:00:00.000Z" }
```

### POST /entries/:id/restore

Request body:
```json
{ "vault_id": "..." }
```

Sets `deleted_at` to NULL. Response `200`:
```json
{ "id": "uuid" }
```

### DELETE /entries/:id/purge

Request body:
```json
{ "vault_id": "..." }
```

Deletes all rows in `entry_history` for the entry, then deletes the entry row. Response `200`:
```json
{ "id": "uuid" }
```

### GET /entries/:id/history

Query parameter: `vault_id` (required).

Response `200`:
```json
[
  {
    "id": "uuid",
    "entry_id": "uuid",
    "commit_hash": "abcdef1234567890abcdef1234567890",
    "encrypted_snapshot": "<base64 blob>",
    "created_at": "2026-01-01T00:00:00.000Z"
  }
]
```

Rows are ordered by `created_at` descending (newest first).

## rqlite HTTP API

The Worker communicates with rqlite using two endpoints:

| Endpoint | Purpose |
|----------|---------|
| `POST /db/query` | Read queries (SELECT) |
| `POST /db/execute` | Write queries (INSERT, UPDATE, DELETE) |

Every request to rqlite carries `Authorization: Basic <base64(username:password)>` using the `RQLITE_URL`, `RQLITE_USERNAME`, and `RQLITE_PASSWORD` Worker secrets.

Parameterized query format (array of `[sql, ...params]`):

```json
[["SELECT id, vault_id, type, encrypted_data, created_at, updated_at FROM entries WHERE vault_id = ? AND deleted_at IS NULL", "vault-id-value"]]
```

rqlite response format for reads:

```json
{
  "results": [
    {
      "columns": ["id", "vault_id", "type", "encrypted_data", "created_at", "updated_at"],
      "types":   ["text", "text", "text", "text", "text", "text"],
      "values":  [["uuid", "vault-id", "login", "<base64>", "...", "..."]]
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

- `vault_id`: required, non-empty, max 256 characters, no `..` or `\`.
- `type`: must be one of `"login"`, `"note"`, `"card"`.
- `id`: required, non-empty, valid UUID format.
- `encrypted_data` / `encrypted_snapshot`: required, valid base64 string, minimum length 137 bytes when decoded (minimum valid blob length).
- `:id` path parameter: valid UUID format.
- `vault_id` from query parameter or body must match the Firebase token's associated vault scope enforced at the Worker level.

All SQL queries use parameterized statements. No string interpolation is used to construct SQL.
