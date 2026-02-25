# Backup and Restore

## Backup Pipeline

```
buildExportData()        — same decrypted JSON as Settings → Export
  → JSON.stringify()
  → brotli compress      — brotli-wasm
  → Ascon-Keccak encrypt — HKDF key derived from root_master_key
  → upload to all targets via S3-compatible PUT
```

The output is an opaque encrypted binary. The cloud storage provider never sees plaintext. Anyone with the `root_master_key` can decrypt and decompress it to recover the full export JSON.

## Export Format

The backup content is identical to the Settings → Export JSON:

```json
{
  "user_id": "...",
  "username": "...",
  "user_master_key_b64": "...",
  "data": [
    { "id": "...", "entry_key_b64": "...", "value": { /* decrypted history object */ } }
  ]
}
```

## Encryption

A backup key is derived from `root_master_key` via HKDF-SHA3-512 with a fresh 64-byte random salt. The compressed payload is then encrypted with Ascon-Keccak-512 AEAD. Blob layout: `salt || ciphertext || tag` (standard format).

## Backup Targets

All three targets use the S3-compatible PUT API via a minimal SigV4 (HMAC-SHA256) implementation — no AWS SDK.

| Target | Endpoint |
|--------|----------|
| Cloudflare R2 | `https://<account_id>.r2.cloudflarestorage.com` |
| AWS S3 | `https://s3.<region>.amazonaws.com` |
| Google Cloud Storage | `https://storage.googleapis.com` |

GCS requires HMAC keys (not service account JSON). Generate in GCS Console → Cloud Storage → Settings → Interoperability.

## Backup File Naming

Each target uploads to a fixed key:

```
<prefix>secbits.brotli-ascon-keccak.bak
```

The file is overwritten on every backup run (last-write-wins). Enable bucket versioning in your storage provider to retain prior copies.

## Config

`backup` is an array of target objects in `config.json`. All targets are written simultaneously. Absent or empty → backup disabled.

```json
{
  "backup": [
    {
      "target": "r2",
      "account_id": "<cloudflare-account-id>",
      "bucket": "secbits-backup",
      "access_key_id": "<r2-access-key-id>",
      "secret_access_key": "<r2-secret-access-key>",
      "prefix": "backups/"
    },
    {
      "target": "s3",
      "region": "us-east-1",
      "bucket": "secbits-backup",
      "access_key_id": "<aws-access-key-id>",
      "secret_access_key": "<aws-secret-access-key>",
      "prefix": "backups/"
    },
    {
      "target": "gcs",
      "bucket": "secbits-backup",
      "access_key_id": "<gcs-hmac-access-key>",
      "secret_access_key": "<gcs-hmac-secret>",
      "prefix": "backups/"
    }
  ]
}
```

| Field | Required by | Purpose |
|-------|-------------|---------|
| `target` | all | `"r2"` / `"s3"` / `"gcs"` |
| `bucket` | all | Bucket name |
| `access_key_id` | all | S3-compatible access key |
| `secret_access_key` | all | S3-compatible secret |
| `prefix` | all | Key prefix (folder). Defaults to `""`. Missing trailing `/` is auto-corrected. |
| `account_id` | R2 only | Cloudflare account ID |
| `region` | S3 only | AWS region (required for endpoint URL and SigV4 scope) |

> **Security:** `access_key_id` and `secret_access_key` are long-lived credentials in the config file. Scope IAM permissions to `s3:PutObject` + `s3:GetObject` on the backup bucket only. Treat the config file as a high-value secret.

## Settings UI

**Backup page** (shown only when `backup` targets are configured):
- **Export** — downloads a decrypted JSON file (`secbits-export-YYYY-MM-DD.json`).
- **Backup now** — uploads encrypted backup to all targets; shows per-target result.
- **Auto-backup after save** — triggers backup after every successful entry write. Disabled by default.
- **Last backup** — timestamp of most recent successful upload (resets on page reload).

**Restore page** (always visible):
- **Source selector** — cloud target or local file. When no targets are configured, only the file picker is shown.
- **File formats accepted**: encrypted `.bak` or plain JSON export (`.json`). Format is auto-detected by first byte (`{` → JSON, anything else → encrypted backup).
- **Confirmation dialog** — shows entry count; warns that the operation replaces all current entries.

## Restore Pipeline

```
read local file or download from target
  → format detection (first byte: '{' = JSON export, else encrypted .bak)

Encrypted .bak path:
  → size check (MAX_RESTORE_BYTES = 10 MB)
  → Ascon-Keccak decrypt with root_master_key
  → brotli decompress (MAX_DECOMPRESSED_BYTES = 50 MB)
  → JSON.parse

JSON export path:
  → size check (MAX_DECOMPRESSED_BYTES = 50 MB)
  → UTF-8 decode + JSON.parse

Both paths:
  → validate user_id matches current user
  → validate data is an array
  → confirm with user (entry count)
  → generate new entry IDs, re-wrap keys, re-encrypt values
  → POST /entries/replace (atomic bulk delete + insert)
```

`Promise.allSettled` ensures a failure on one backup target does not prevent upload to the others. Per-target success/error is surfaced in the UI.
