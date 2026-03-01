# Features

## Vault

| Feature | Detail |
|---------|--------|
| End-to-end encryption | All secrets encrypted at rest with Ascon-Keccak-512 AEAD. Plaintext never written to disk. |
| Offline-first | All data in local SQLite. No network required for normal operation. |
| Entry types | Three types: Login, Secure Note, Credit Card. Type set at creation; immutable. |
| Version history | Up to 20 commits per entry. Field-level diffs. Restore to any prior commit. |
| Trash | Soft delete with restore. Permanent delete from trash. Full history preserved. |
| Export | Download decrypted vault as JSON (includes trash). |
| Encrypted backups | Optional S3-compatible push/pull (Cloudflare R2, AWS S3, GCS, MinIO). |

## Entry Types

### Login

Credentials for a website or service.

| Field | Notes |
|-------|-------|
| Title | Required |
| Username | Optional |
| Password | Optional; password generator available |
| Notes | Free text |
| URLs | Multiple URLs |
| TOTP secrets | Multiple RFC 6238 TOTP secrets |
| Custom fields | Arbitrary label/value pairs |
| Tags | Multiple tags |

### Secure Note

Free-form encrypted text.

| Field | Notes |
|-------|-------|
| Title | Required |
| Notes | Main content |
| Tags | Multiple tags |

### Credit Card

Payment card details.

| Field | Notes |
|-------|-------|
| Title | Required |
| Cardholder name | Optional |
| Card number | Optional |
| Expiry | Optional; MM/YY format |
| CVV | Optional |
| Notes | Free text |
| Tags | Multiple tags |

## TOTP

Live RFC 6238 TOTP codes displayed inline:
- 30-second step, HMAC-SHA1, 6-digit output.
- Per-code countdown timer.
- Multiple secrets per entry.
- Auto-refresh on step boundary.
- Copy-to-clipboard button.

## Password Generator

Configurable random password generation:
- Length: configurable.
- Character classes: uppercase, lowercase, digits, symbols.
- Symbol set (30 chars): `!@#$%^&*()_+-=[]{}|;:,.<>?/~\`'`
- `"` and `\` excluded (require escaping in JSON).
- Uses cryptographically secure random source.

## Version History

- Per-entry, capped at 20 commits.
- Each commit identified by a 32-hex-character SHA-256 content hash.
- `changed` array lists fields that differ from the prior commit.
- Field-level diff viewer in the UI: shows old/new values side-by-side.
- Restore to any commit: creates a new commit with the restored snapshot.
- Dedup: saving with no semantic change does not create a commit.

## Trash

Deleting an entry moves it to trash (soft delete). Trashed entries:
- Retain full field values and commit history.
- Show a `deletedAt` timestamp.
- Are read-only in the UI.
- Can be **Restored** (moved back to active) or **Permanently deleted**.

The trash is included in vault exports.

## Search and Filter

- Full-text search across entry titles, usernames, and URLs.
- Tag sidebar for filtering by tag. Tag counts shown.
- Combined filter: tag + search string.

## Settings

| Page | Feature |
|------|---------|
| Export | Download decrypted vault as JSON |
| Security | Generate root master key (256 bytes from backend OsRng, displayed as base64); rotate (re-encrypt UMK blob only; entries unaffected) |
| Backups | Push to / pull from configured S3 targets |
| About | Vault stats: entry count, type breakdown, field coverage per field, version history metrics (avg/max commits, never-edited count), top tags |

## Vault Unlock / Session

- On launch, app reads config file for `root_master_key`, `db_path`, `username`.
- Unlock: config is loaded, user master key decrypted, session established.
- Lock: session keys zeroed in Rust (`AppState`), React state cleared.
- No persistent login state; unlock required on each app launch.

## Backups

Optional S3-compatible encrypted backups.

- `backup push [--target <name>]`: encrypt and upload local SQLite file to S3.
- `backup push --all`: push to all configured targets.
- `backup pull --target <name>`: download, decrypt, and atomically replace local DB.
- `backup_on_save = true` in config: auto-push after each write operation.

Backup blob: AEAD-encrypted copy of the raw SQLite file. Storage provider sees
only opaque ciphertext. S3 object keys include ISO 8601 timestamps for
lexicographic ordering.

## Entry Sharing

Share individual entry snapshots with other SecBits users via `.sbsh` files:
- Uses ML-KEM-1024 + X448 hybrid KEM (post-quantum safe, forward secrecy).
- Only the current `head_snapshot` is shared; commit history is not included.
- `.sbsh` files are self-contained; no server required; any channel works.
- Recipient imports with `share-receive`; entry is added to their vault.
