# Backend

Cloudflare Worker + Cloudflare R2.

```
Browser -> Worker -> R2
```

Authentication: Firebase ID token (`Authorization: Bearer <token>`). The Worker verifies the token and uses `token.sub` as user identity. All routes except `/health` require a valid token.

## Storage Model

One encrypted binary object per user vault. The Worker never handles plaintext vault content — it reads and writes opaque bytes only.

Inside that encrypted payload:
- `data`: active entries
- `trash`: soft-deleted entries with `deletedAt`

Entry IDs are client-generated UUIDs (`crypto.randomUUID()`).

R2 object key:
```
{prefix}/{vault_id}/{file_name}
```
All three path segments are supplied by the client from its config JSON (`r2.prefix`, `vault_id`, `r2.file_name`). They are validated and sanitized server-side. The bearer token is still verified on every request; `vault_id` determines the storage path independently of the auth provider.

## API

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/vault/read` | Read encrypted vault blob from R2 |
| `POST` | `/vault/write` | Write encrypted vault blob to R2 |
| `GET`  | `/health` | Health check (no auth required) |

All vault routes require `Authorization: Bearer <firebase-id-token>`. Read uses `Content-Type: application/json`; write uses `Content-Type: application/octet-stream`.

---

### POST /vault/read

Request body (`application/json`):
```json
{
  "bucket_name": "secbits-data",
  "prefix": "<r2.prefix from config>",
  "vault_id": "<vault_id from config>",
  "file_name": "vault.bin"
}
```

Response (object exists): `200 application/octet-stream` — raw encrypted blob bytes.
Metadata in response headers:
```
X-Vault-Size: 4096
X-Vault-Etag: "abc123"
X-Vault-Uploaded: 2026-01-01T00:00:00.000Z
```

Response (first login / object not yet created): `204 No Content` (no body).

---

### POST /vault/write

Request headers:
```
Content-Type: application/octet-stream
X-Vault-Bucket: secbits-data
X-Vault-Prefix: <r2.prefix from config>
X-Vault-Id: <vault_id from config>
X-Vault-File: vault.bin
```

Request body: raw encrypted blob bytes.

Response (`application/json`):
```json
{
  "ok": true,
  "size": 4096
}
```

---

## Path Validation

The Worker validates all path parts before constructing the R2 key:
- `bucket_name` must match the Worker's `R2_BUCKET_NAME` environment variable.
- `prefix`, `vault_id`, and `file_name` must not be empty and must not contain `..` or `\`.

## Worker Secrets

| Secret | Purpose |
|--------|---------|
| `FIREBASE_PROJECT_ID` | Used to verify the `aud` claim in Firebase ID tokens |
| `R2_BUCKET_NAME` | Validated against the client-supplied `bucket_name` |

The R2 bucket is bound to the Worker via `wrangler.toml` (binding name: `SECBITS_R2`).
