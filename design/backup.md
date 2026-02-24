> Part of [Design Docs](../design.md).

# Backup Design

## Goal

Two backup modes:

- **Manual backup** — triggered by the user from Settings at any time.
- **Auto-backup after save** — automatically uploads a backup whenever an entry is created, updated, or deleted. Disabled by default; toggled in Settings.

Multiple backup targets can be configured and are all written to simultaneously on each backup run.

## Backup Pipeline

```
buildExportData()        — same decrypted JSON as Settings → Export
  → JSON.stringify()
  → brotli compress      — brotli-wasm
  → Ascon-Keccak encrypt — HKDF key derived from root_master_key
  → upload to all targets via S3-compatible PUT
```

The output is an opaque encrypted binary. The cloud storage provider never sees plaintext. The file is self-contained: anyone with the `root_master_key` can decrypt and decompress it to recover the full export JSON.

## Export Format

The backup content is identical to the Settings → Export JSON.

## Encryption

A backup-specific key is derived from `root_master_key` via HKDF-SHA3-512 (same KDF used throughout the app), then the compressed payload is encrypted with Ascon-Keccak-512 AEAD. The blob layout follows the standard format: `salt || ciphertext || tag`.

HKDF-SHA3-512 takes a freshly generated 64-byte random salt and produces 128 bytes split as `key(64B) || IV(64B)`. The IV (nonce) is derived deterministically from the salt and root key — it is not stored separately in the blob. A new random salt per encryption ensures nonce uniqueness across all backups.

## Backup Targets

All three targets expose an S3-compatible PUT object API. A single AWS Signature V4 implementation covers all of them; only the endpoint URL differs.

| Target | Endpoint |
|--------|----------|
| Cloudflare R2 | `https://<account_id>.r2.cloudflarestorage.com` |
| AWS S3 | `https://s3.<region>.amazonaws.com` |
| Google Cloud Storage | `https://storage.googleapis.com` |

GCS requires HMAC keys (not a service account JSON) to use the S3-compatible XML API. Generate them in GCS Console → Cloud Storage → Settings → Interoperability.

## Backup File Naming

Each target uploads to a fixed key:

```
<prefix>secbits.brotli-ascon-keccak.bak
```

The file is overwritten on every backup run. **Concurrent backups from multiple devices or browser tabs silently overwrite each other (last-write-wins); there is no merge or conflict detection.** There is no timestamped archive — enable bucket versioning (R2 Lifecycle, S3 Versioning, GCS Object Versioning) in the storage provider's console to retain prior copies and recover from accidental overwrites.

## Config File

`backup` is an array of target objects in `config.json`. All listed targets are written to simultaneously. If the key is absent or the array is empty, backup is disabled entirely.

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
| `prefix` | all | Key prefix (folder) inside the bucket. Empty string (`""`) or a string ending with `/` (e.g. `"backups/"`). A missing trailing slash is automatically corrected at runtime by appending `/`. Defaults to `""`. |
| `account_id` | R2 only | Cloudflare account ID (used to build the endpoint URL) |
| `region` | S3 only | AWS region. Required for S3 targets — both the endpoint URL and the SigV4 signature scope embed it; an absent or wrong region causes signature errors. R2 and GCS do not use this field. |

> **Security warning:** `access_key_id` and `secret_access_key` are long-lived credentials stored in the config file. If the config file is leaked, an attacker can read and overwrite backup objects (and potentially all objects in the bucket, depending on the IAM policy). Mitigate by:
> - Scoping IAM/token permissions to the minimum required: `s3:PutObject` + `s3:GetObject` on the backup bucket and prefix only.
> - Using Cloudflare R2 API tokens with per-bucket scope rather than global account keys.
> - Treating the config file as a high-value secret — do not share it or commit it to version control.

## Settings UI

Settings are split into two separate pages.

**Backup page** — shown only when `backup` is present in the config with at least one valid target entry:

- **Export** — "Export all data" button downloads a decrypted JSON file (`secbits-export-YYYY-MM-DD.json`) to disk. The file contains all entries, the decrypted user master key, and per-entry doc keys. Keep this file secure.
- **"Backup now"** button — uploads an encrypted backup to all configured targets immediately; shows per-target success/error inline.
- **"Auto-backup after save"** toggle — disabled by default. When enabled, a backup is triggered after every successful entry write. A failed upload is logged but does not block the save. **Note:** rapid successive writes (bulk imports, scripted updates) trigger a backup per save; consider debouncing or rate-limiting uploads to avoid excessive API request counts and storage costs.
- **Last backup** — displays the timestamp of the most recent successful upload (stored in `sessionStorage`; resets on page reload).

**Restore page** — always visible regardless of whether backup targets are configured:

- **Source selector** — shown only when at least one cloud target is configured; lists each target by label (`r2 · my-bucket`, `s3 · my-bucket`, etc.) plus a **"Local file"** option. When no targets are configured, only the file picker is shown.
  - Selecting a target downloads `<prefix>secbits.brotli-ascon-keccak.bak` from that target via S3 GET.
  - Selecting "Local file" opens a file picker to choose a `.bak` file from disk.
- **"Restore"** button — enabled once a source is selected. Triggers the restore pipeline (see below).
- **Confirmation dialog** — before writing, shows the entry count from the backup and a warning: *"This will replace all current entries. This cannot be undone."* User must confirm to proceed.
- **Status** — inline success message or per-step error after the operation completes.

## Client Implementation

```js
async function runBackup({ exportData, rootMasterKey, targets }) {
  const json     = JSON.stringify(exportData);
  const jsonBytes = new TextEncoder().encode(json);
  const compressed = await brotliCompress(jsonBytes);         // brotli-wasm
  const encrypted  = await encryptBackup(compressed, rootMasterKey); // HKDF + Ascon-Keccak

  await Promise.allSettled(targets.map(t => uploadToTarget(t, encrypted)));
}

function resolveEndpoint({ target, account_id, region }) {
  if (target === 'r2')  return `https://${account_id}.r2.cloudflarestorage.com`;
  if (target === 's3')  return `https://s3.${region}.amazonaws.com`;
  if (target === 'gcs') return 'https://storage.googleapis.com';
  throw new Error(`Unknown backup target: ${target}`);
}

async function uploadToTarget(targetConfig, body) {
  const { bucket, access_key_id, secret_access_key, prefix = '', region = 'auto' } = targetConfig;
  const endpoint = resolveEndpoint(targetConfig);
  const key = `${prefix}secbits.brotli-ascon-keccak.bak`;
  await sigV4Put({ endpoint, bucket, key, body, access_key_id, secret_access_key, region, service: 's3' });
}
```

`sigV4Put` is a minimal Web Crypto implementation of AWS Signature V4 (HMAC-SHA256) — no AWS SDK dependency. `Promise.allSettled` ensures a failure on one target does not prevent upload to the others.

> **Partial failure:** if one target fails the others still succeed, leaving targets in divergent states. The UI must surface per-target success/error status so the user knows which targets hold the most recent backup. When restoring, the user should select the target that received the most recent successful upload.

## Restore Pipeline

```
download from target (S3 GET) or read local file
  → size check                 — reject blobs larger than MAX_RESTORE_BYTES (default 10 MB)
  → decrypt with Ascon-Keccak  — same HKDF key derived from root_master_key
  → brotli decompress          — reject if decompressed size > MAX_DECOMPRESSED_BYTES (default 50 MB)
  → JSON.parse()               — recover export JSON
  → validate user_id           — abort if exportData.user_id ≠ current user
  → validate shape             — abort if exportData.data is not an array
  → confirm with user          — show entry count, warn of overwrite
  → atomically: delete all existing entries + write restored entries (single db.transact)
```

The restore is a full replace executed as a **single atomic transaction**: deletes and writes are batched into one `db.transact` call. This prevents a crash or network failure between the two steps from leaving the account empty or partially written. There is no merge.

> **Race window:** `fetchAllEntries` and `db.transact` are separate operations. Entries created concurrently (from another tab or device) in the interval between those two calls will not be captured in the delete set and will survive the restore. To guarantee a true full replace, avoid using the app from other sessions while a restore is in progress.

```js
const MAX_RESTORE_BYTES      = 10 * 1024 * 1024; // 10 MB — encrypted blob limit
const MAX_DECOMPRESSED_BYTES = 50 * 1024 * 1024; // 50 MB — decompressed output limit (bomb guard)

async function runRestore({ source, rootMasterKey, userId, userMasterKey }) {
  // 1. Fetch encrypted blob
  const blob = source.type === 'target'
    ? await sigV4Get({ ...resolveTargetParams(source.config) })
    : await source.file.arrayBuffer();

  // 1b. Reject oversized blobs before attempting decryption/decompression
  if (blob.byteLength > MAX_RESTORE_BYTES) {
    throw new Error(`Backup file too large (${blob.byteLength} B > ${MAX_RESTORE_BYTES} B limit)`);
  }

  // 2. Decrypt + decompress
  const compressed = await decryptBackup(new Uint8Array(blob), rootMasterKey);
  const jsonBytes  = await brotliDecompress(compressed);

  // 2b. Guard against decompression bombs
  if (jsonBytes.byteLength > MAX_DECOMPRESSED_BYTES) {
    throw new Error(`Decompressed backup too large (${jsonBytes.byteLength} B > ${MAX_DECOMPRESSED_BYTES} B limit)`);
  }

  const exportData = JSON.parse(new TextDecoder().decode(jsonBytes));

  // 2c. Validate identity — refuse to restore a backup from a different account
  if (exportData.user_id !== userId) {
    throw new Error('Backup belongs to a different user account; restore aborted.');
  }

  // 2d. Basic shape check — catch malformed backups before the destructive replace step
  if (!Array.isArray(exportData.data)) {
    throw new Error('Backup is malformed: exportData.data must be an array.');
  }

  // 3. Confirm (UI shows exportData.data.length entries)

  // 4+5. Atomically delete existing entries and write restored entries in one transaction.
  //      Combining both steps prevents the account being left empty if the write step fails.
  //      Note: entry IDs are regenerated (generateId()); original IDs from the backup are not preserved.
  const { entries } = await fetchAllEntries(userId);
  const deleteTxns = entries.map(e => tx.entries[e.id].delete());
  const writeTxns  = await Promise.all(exportData.data.map(async (doc) => {
    const { entryKey, value } = await encryptEntry(doc, userMasterKey);
    const entryId = generateId();
    return tx.entries[entryId]
      .update({ entryKey, value, createdAt: doc.createdAt, updatedAt: doc.updatedAt })
      .link({ owner: userId });
  }));
  await db.transact([...deleteTxns, ...writeTxns]);
}
```

The S3 GET uses the same SigV4 implementation as the upload, with `sigV4Get` performing a presigned or header-signed GET request for the same fixed key (`<prefix>secbits.brotli-ascon-keccak.bak`).
