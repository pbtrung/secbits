# Features

## Vault

| Feature | Detail |
|---------|--------|
| End-to-end encryption | Export JSON → Brotli compress → AEAD encrypt → R2. Plaintext never leaves the browser. |
| Single vault object | All entries stored as one encrypted blob in R2. |
| Version history | Each entry tracks up to 20 commits. Head snapshot stored directly; older commits store field-level deltas. |
| Export | Download full decrypted vault as JSON. |

## Entry Fields

| Field | Notes |
|-------|-------|
| Title | Required identifier |
| Username | Optional |
| Password | Optional |
| Notes | Free text |
| URLs | Multiple URLs per entry |
| TOTP secrets | Multiple RFC 6238 TOTP secrets per entry |
| Custom fields | Arbitrary key/value pairs |
| Tags | Multiple tags per entry |

## TOTP

Live RFC 6238 TOTP codes displayed inline. 30-second step, HMAC-SHA1, 6-digit output. Countdown timer per code. Multiple secrets per entry supported.

## Password Generator

Configurable password generator. Options: length, uppercase, lowercase, digits, symbols.

## Search and Filter

- Full-text search across entry titles and usernames.
- Tag sidebar for filtering by tag.

## History

- Per-entry version history, capped at 20 commits.
- Field-level diff viewer between any two commits.
- Commit timestamps.

## Settings

| Page | Feature |
|------|---------|
| Export | Download decrypted vault as JSON |
| Security | Rotate root master key (generates new key, re-encrypts vault) |
| About | Vault stats: entry count, stored/export sizes, field coverage, version history metrics, top tags, largest entries |

## Authentication

Firebase email/password. Config JSON holds credentials and is loaded at startup. Session is in-memory only — cleared on reload or logout.
