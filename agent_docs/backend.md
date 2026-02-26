# Backend Architecture

Backend is Cloudflare Worker + Cloudflare R2.

```text
Browser -> Worker -> R2
```

Authentication is Firebase ID token (`Authorization: Bearer <token>`). Worker verifies token and uses `token.sub` as user identity.

## Storage Model

- One encrypted object per user vault state.
- Object bytes are produced client-side by:
  - export JSON
  - compress
  - encrypt
- Worker never decrypts plaintext vault content.

R2 object location is config-driven with:
`bucket-name/prefix/file-name`

All three path parts are read from the client config JSON and sent to Worker as request parameters.

## Worker API

All routes require a valid Firebase token.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/vault` | Read encrypted vault blob from R2 |
| `PUT` | `/vault` | Write encrypted vault blob to R2 |
| `GET` | `/health` | Optional health check |

Suggested request shape for `/vault` routes:

```json
{
  "r2": {
    "bucket_name": "secbits-data",
    "prefix": "users/",
    "file_name": "vault.bin"
  }
}
```

`PUT /vault` additionally includes encrypted payload bytes (or base64 payload) and metadata fields if needed.

## Write Flow

1. Worker verifies Firebase token.
2. Worker validates `bucket_name`, `prefix`, `file_name`.
3. Worker writes encrypted blob to R2 key `prefix + file_name` in `bucket_name`.
4. Worker returns write metadata (etag/version/timestamp when available).

## Read Flow

1. Worker verifies Firebase token.
2. Worker resolves R2 object key from request config fields.
3. Worker reads object bytes.
4. Worker returns encrypted blob to client.

If object does not exist (first login), return 404 or an explicit empty-state response.

## Removed Components

- No Turso/libSQL/D1 usage.
- No `entries` table or relational schema.
- No backup-specific APIs.
