# Backup — SecBits

## Overview

Encrypted cloud backups to S3-compatible object storage (R2, AWS S3, GCS).
Backup payload = AEAD-encrypted raw SQLite DB bytes. Never upload plaintext.

## Config

```toml
backup_on_save = false  # auto-trigger push --all after insert/edit/restore

[targets.r2]
provider = "r2"
endpoint = "https://<account>.r2.cloudflarestorage.com"
region = "auto"
bucket = "secbits-backups-r2"
prefix = "prod/"
access_key_id = "..."
secret_access_key = "..."
session_token = ""  # optional
```

Provider values: `r2`, `aws`, `gcs`.

## Backup Blob Format

`backup_salt(64) || ciphertext || tag(64)` — same structure as `encryptBytesToBlob`.

Key derivation: `HKDF-SHA3-512(root_master_key, backup_salt)` → `backup_enc_key[64] || backup_enc_iv[64]`.

## Object Key Format

`<prefix><username>/<timestamp_utc_iso8601>.secbits.enc`

Example: `prod/alice/2026-02-22T10:30:00Z.secbits.enc`

"Latest" object: lexicographically largest key under `<prefix><username>/` (ISO-8601 timestamps sort correctly this way).

## backup push Steps

1. Validate root master key.
2. Resolve targets from `--target <name>` or `--all`. Error if neither provided.
3. Read `db_path` as raw bytes.
4. Generate `backup_salt`; derive `backup_enc_key` + `backup_enc_iv` via HKDF.
5. AEAD-encrypt DB bytes.
6. Assemble blob: `backup_salt || ciphertext || tag`.
7. Upload to each target. Object key = `<prefix><username>/<timestamp>.secbits.enc`.
8. Return per-target key on success; `BackupUploadFailed` on any failure.

## backup pull Steps

Safe replace: write to `<db_path>.tmp`, then rename atomically. On any failure, delete `.tmp` and return `BackupRestoreFailed` without touching existing DB.

1. Validate root master key.
2. Resolve target from `--target <name>`. Error if not configured.
3. Resolve object key: use `--object <key>` if provided, else list + pick largest.
4. Download blob. Error: `BackupDownloadFailed`.
5. Parse: `backup_salt = blob[0..64]`, `ciphertext`, `tag`.
6. Re-derive keys; AEAD-decrypt. Error: `BackupDecryptFailed`.
7. Warn user about data loss; require explicit confirmation.
8. Write to `<db_path>.tmp`; rename to `db_path`. Error: `BackupRestoreFailed`.
9. Print confirmation with object key and size.

## backup_on_save

When `backup_on_save = true` in config, after every successful `insert`, `edit`, or `restore`, automatically invoke `backup push --all`.
