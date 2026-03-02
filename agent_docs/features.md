# Features

## Vault

| Feature | Detail |
|---------|--------|
| End-to-end encryption | Entry JSON -> Brotli compress -> AEAD encrypt -> base64 -> rqlite. Plaintext never leaves the browser. |
| Per-entry storage | Each entry is an independently encrypted blob stored as a row in rqlite. |
| Version history | Each entry tracks up to 20 commits. Each commit is an independently encrypted full snapshot identified by a 32-hex-character (128-bit) SHA-256 hash. |
| Trash | Deleted entries are soft-deleted (deleted_at set). Full commit history is preserved. Entries can be restored or permanently deleted from trash. |
| Export | Download full decrypted vault as JSON (includes both live entries and trash). |

## Entry Types

When adding a new entry the user first selects one of three types. The type is stored on the entry as a `type` field (`"login"`, `"note"`, `"card"`) and controls which fields are shown in the editor and detail view. The type is fixed at creation and cannot be changed afterward. It is stored in plaintext in the `entries` table (for Worker-side metadata) and also included inside the encrypted blob.

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
- Each commit is an independently encrypted full snapshot stored in rqlite.
- Field-level diff viewer between any two commits.
- Commit timestamps.
- When the 20-commit cap is reached, the oldest commit is deleted from rqlite before the new one is inserted.

## Trash

Deleting an entry sets its `deleted_at` timestamp in rqlite rather than erasing the row.

Each trashed entry retains:
- All original fields (inside the encrypted blob).
- The full commit history (all `entry_history` rows are preserved).
- A `deleted_at` ISO 8601 timestamp in the `entries` row.

Operations on trashed entries:
- **Restore**: sets `deleted_at` to NULL; entry moves back to the live list.
- **Permanent delete**: removes the entry row and all `entry_history` rows from rqlite with no recovery path.

The trash is not shown in the main entry list or search results.

UI behavior:
- A trash icon is shown next to the settings gear in the sidebar.
- The trash icon is disabled when trash is empty.
- Clicking trash switches column 2 to deleted entries.
- Deleted entries are read-only: inline edit is disabled.
- Deleted entry actions are limited to: **Restore**, **Versions**, **Delete** (permanent, red, right-aligned).

## Settings

| Page | Feature |
|------|---------|
| Export | Download decrypted vault as JSON |
| Security | Rotate root master key (generates new key, re-encrypts all entry and history blobs) |
| About | Vault stats: entry count, field coverage, version history metrics, top tags, largest entries |

## Authentication

Firebase email/password. Config JSON holds credentials and is loaded at startup. Session is in-memory only — cleared on reload or logout.
