# Features

What is actually decided for this rebuild so far. Anything not listed here is undecided, not assumed.

## Vault

- Entries: an id, an owner link, an `entryKey` blob, and an `encryptedData` blob. Everything about the entry, type, title, fields, tags, notes, and timestamps, lives inside `encryptedData`; none of it is plaintext (see docs/data_model.md, Entities).
- Three entry types, every entry also has `title`, `notes`, `tags`, and `customFields` regardless of type:
  - `login`: `username`, `password`, `urls` (multiple), TOTP secrets (multiple).
  - `note`: no type specific fields beyond the common ones above.
  - `card`: `cardholderName`, `cardNumber`, `cardExpiry`, `cardCvv`.

## History

- Every save creates an `entryHistory` row, an immutable point in time snapshot of the entry (see docs/data_model.md, docs/crypto.md).
- Capped at the most recent 20 commits per entry; the oldest is pruned once the cap is exceeded.
- Enforcement runs client side, since timestamps are encrypted and InstantDB cannot read them (see docs/architecture.md, Maintenance: client side).
- A commit hash embedded in each snapshot, computed over a canonical JSON representation, lets the client verify a decrypted snapshot has not been altered (see docs/crypto.md, Commit Hash).

## Trash

- Soft delete via an encrypted `deletedAt` timestamp inside `encryptedData`.
- Entries past a retention window are purged client side on load. Currently 30 days (`TRASH_RETENTION_MS` in `src/db.js`), provisional and subject to change.

## Backup

- Local: on demand export of the full, decrypted vault as plain, unencrypted JSON, downloaded to the user's machine. No encryption involved; this is a deliberate, unprotected escape hatch, see docs/security.md for the risk it creates.
- Cloud: on demand export of the same vault content, Brotli compressed and AEAD encrypted under `backup_master_key` from config, uploaded directly from the client to Cloudflare R2 and to every configured S3 compatible destination, one or more (see docs/crypto.md, Cloud Backup). No server proxy; each destination is uploaded independently, so one failing does not block the others.
- Retention of past cloud backup objects is not yet decided.

## Key management

- `root_master_key` rotation: re encrypts `keyStore.umkBlob`.
- UMK rotation: re encrypts every entry's `entryKey`, atomically, in one InstantDB transaction (see docs/crypto.md, Key Rotation).
- `backup_master_key` rotation: a config only value; there is nothing in InstantDB to rewrite, so rotation is just changing it in the config file. Affects future cloud backups only, not ones already uploaded (see docs/crypto.md, Key Rotation).

## Auth

- Firebase Authentication, email and password from local config, no interactive step.
- Firebase ID token exchanged for an InstantDB session via `db.auth.signInWithIdToken` (see docs/architecture.md, Auth: Firebase through InstantDB).
- `username` from local config is displayed in the UI; it is cosmetic only, not part of the auth flow and not stored in InstantDB.

## Multi user

- Every user's `keyStore`, `entries`, and `entryHistory` rows are strictly isolated by owner; no sharing between users (see docs/data_model.md, Multi user, no sharing).

## Deliberately deferred

- Sharing entries between users: needs a public/private keypair per user, not implemented.
- One time share links: needs a new unauthenticated read path; a true single view guarantee needs a privileged component this design otherwise avoids.
