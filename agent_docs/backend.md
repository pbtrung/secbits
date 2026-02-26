# Backend

Cloudflare Worker + Cloudflare R2.

```
Browser -> Worker -> R2
```

Authentication: Firebase ID token (`Authorization: Bearer <token>`). The Worker verifies the token and uses `token.sub` as user identity. All routes except `/health` require a valid token.

## Storage Model

One encrypted binary object per user vault. The Worker never handles plaintext vault content — it reads and writes opaque bytes only.

R2 object path is config-driven:
```
{prefix}{file_name}
```
within the bucket bound to the Worker. All path parts are validated server-side.

## API

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/vault/read` | Read encrypted vault blob from R2 |
| `POST` | `/vault/write` | Write encrypted vault blob to R2 |
| `GET`  | `/health` | Health check (no auth required) |

All vault routes require `Content-Type: application/json` and `Authorization: Bearer <firebase-id-token>`.

---

### POST /vault/read

Request body:
```json
{
  "bucket_name": "secbits-data",
  "prefix": "users/",
  "file_name": "vault.bin"
}
```

Response (object exists):
```json
{
  "exists": true,
  "payload_b64": "<base64-encoded encrypted blob>",
  "key": "users/vault.bin",
  "size": 4096,
  "etag": "\"abc123\"",
  "uploaded": "2026-01-01T00:00:00.000Z"
}
```

Response (first login / object not yet created):
```json
{
  "exists": false,
  "key": "users/vault.bin",
  "payload_b64": null
}
```

---

### POST /vault/write

Request body:
```json
{
  "bucket_name": "secbits-data",
  "prefix": "users/",
  "file_name": "vault.bin",
  "payload_b64": "<base64-encoded encrypted blob>"
}
```

Response:
```json
{
  "ok": true,
  "key": "users/vault.bin",
  "size": 4096
}
```

---

## Path Validation

The Worker validates all path parts before constructing the R2 key:
- `bucket_name` must match the Worker's `R2_BUCKET_NAME` environment variable.
- `prefix` and `file_name` must not be empty, must not contain `..` or `\`.
- `prefix` is normalized to always end with `/` if non-empty.

## Worker Secrets

| Secret | Purpose |
|--------|---------|
| `FIREBASE_PROJECT_ID` | Used to verify the `aud` claim in Firebase ID tokens |
| `R2_BUCKET_NAME` | Validated against the client-supplied `bucket_name` |

The R2 bucket is bound to the Worker via `wrangler.toml` (binding name: `SECBITS_R2`).
