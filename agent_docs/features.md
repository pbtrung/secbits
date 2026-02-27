# Features

## Vault

| Feature | Detail |
|---------|--------|
| End-to-end encryption | Export JSON → Brotli compress → AEAD encrypt → R2. Plaintext never leaves the browser. |
| Single vault object | All entries stored as one encrypted blob in R2. |
| Version history | Each entry tracks up to 20 commits. Each commit is identified by a 32-hex-character (128-bit) SHA-256 hash. Head snapshot stored directly; older commits store field-level deltas. |
| Trash | Deleted entries move to a trash bin with a deletion timestamp. Full commit history is preserved. Entries can be restored or permanently deleted from trash. |
| Export | Download full decrypted vault as JSON (includes both live entries and trash). |

## Entry Types

When adding a new entry the user first selects one of three types. The type is stored on the entry as a `type` field (`"login"`, `"note"`, `"card"`) and controls which fields are shown in the editor and detail view. The type is fixed at creation and cannot be changed afterward. It is preserved in the vault export JSON alongside all other entry fields.

**UI — type selection:** clicking the `+` button in the entry list opens a dropdown menu with three items (Login, Secure Note, Credit Card). Selecting an item creates a new entry of that type and immediately opens it in edit mode.

**UI — type badge:**
- **Read-only mode:** a non-interactive type badge is rendered directly below the entry title, using the same visual style as the "Deleted" badge shown on trashed entries.
- **Edit mode:** the same badge is rendered below the title input field. It is display-only; no control to change the type is shown.

### Login

Credentials for a website or service.

| Field | Notes |
|-------|-------|
| Title | Required |
| Username | Optional |
| Password | Optional; password generator available |
| Notes | Free text |
| URLs | Multiple URLs per entry |
| TOTP secrets | Multiple RFC 6238 TOTP secrets per entry |
| Custom fields | Arbitrary key/value pairs |
| Tags | Multiple tags per entry |

### Secure Note

Free-form encrypted text.

| Field | Notes |
|-------|-------|
| Title | Required |
| Notes | Main content; free text |
| Tags | Multiple tags per entry |

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
| Tags | Multiple tags per entry |

## TOTP

Live RFC 6238 TOTP codes displayed inline. 30-second step, HMAC-SHA1, 6-digit output. Countdown timer per code. Multiple secrets per entry supported.

## Password Generator

Configurable password generator. Options: length, uppercase, lowercase, digits, symbols.

Symbol set (30 chars): `!@#$%^&*()_+-=[]{}|;:,.<>?/~`'`

`"` and `\` are excluded — both require escaping in JSON and would corrupt vault export.

## Search and Filter

- Full-text search across entry titles and usernames.
- Tag sidebar for filtering by tag.

## History

- Per-entry version history, capped at 20 commits.
- Each commit identified by a 32-hex-character (128-bit) truncation of a SHA-256 content hash.
- Field-level diff viewer between any two commits.
- Commit timestamps.

## Trash

Deleting an entry moves it to a `trash` array in the vault JSON rather than erasing it immediately.

Each trashed entry carries:
- All original fields and the full `_commits` history.
- A `deletedAt` ISO 8601 timestamp added at deletion time.

Operations on trashed entries:
- **Restore**: moves the entry back to `data`, strips `deletedAt`.
- **Permanent delete**: removes the entry from `trash` with no recovery path.

The trash is included in the encrypted vault blob and in vault exports. It is not shown in the main entry list or search results.

UI behavior:
- A trash icon is shown next to the settings gear in the sidebar.
- The trash icon is disabled when `trash` is empty.
- Clicking trash switches column 2 to deleted entries.
- Deleted entries are read-only: inline edit is disabled.
- Deleted entry actions are limited to: **Restore**, **Versions**, **Delete** (permanent, red, right-aligned).

## Settings

| Page | Feature |
|------|---------|
| Export | Download decrypted vault as JSON |
| Security | Rotate root master key (generates new key, re-encrypts vault) |
| About | Vault stats: entry count, stored/export sizes, field coverage, version history metrics, top tags, largest entries |

## Storage Path

R2 object key format: `{r2.prefix}/{vault_id}/{r2.file_name}`. All three segments are sourced from the config JSON and validated server-side. `vault_id` is auth-provider independent, keeping the path stable across auth changes.

## Authentication

Firebase email/password. Config JSON holds credentials and is loaded at startup. Session is in-memory only — cleared on reload or logout.
