# SecBits

End to end encrypted password manager.

Stack:
- Frontend: React + Vite, deployed to Cloudflare Pages
- Auth: Firebase Authentication (email/password) exchanged for an InstantDB session via `db.auth.signInWithIdToken`
- Database: InstantDB (client writes directly, scoped by permission rules)

There is no custom backend. The frontend talks directly to Firebase (auth) and InstantDB (session and data); all maintenance (history cap, trash purge) runs client side since every field, including timestamps, is encrypted and the server never holds decryption keys.

## Layout

```text
src/
  App.jsx          root state and session flow
  db.js            InstantDB client init and queries
  crypto.js        per-entry encrypt/decrypt pipeline
  components/      UI components
  tests/           Vitest test suites
instant.schema.ts  InstantDB entity and link definitions
instant.perms.ts   InstantDB permission rules
```

## Runtime Flow

Login:
1. App authenticates with Firebase using email and password from config.
2. App retrieves the Firebase ID token and exchanges it for an InstantDB session via `db.auth.signInWithIdToken`.
3. App subscribes to the current user's entries, scoped by InstantDB permission rules on `auth.id`.
4. App decrypts each entry blob and loads the vault.

Save (create or update):
1. App serializes entry to JSON, including type, tags, and timestamps — everything.
2. App Brotli compresses the JSON bytes.
3. App AEAD encrypts the compressed bytes with a fresh random salt.
4. App base64 encodes the blob and writes it directly to InstantDB via `db.transact`.
5. InstantDB permission rules confirm the row belongs to the authenticated user before accepting the write.

Maintenance (client side, on load/save):
1. App decrypts an entry's linked history rows to read their embedded timestamps.
2. App deletes the oldest history rows past the cap of the most recent 20 per entry.
3. App decrypts trashed entries' embedded `deletedAt` and permanently deletes those past the retention window.

Backup (on demand):
1. Local: App decrypts every entry and lets the user download the full vault as plain, unencrypted JSON. No encryption pipeline involved.
2. Cloud: App assembles the same plain JSON, Brotli compresses it, AEAD encrypts it under `backupKey` (fresh salt, current format version), and uploads it directly from the client to Cloudflare R2 and to each configured S3 compatible endpoint using access keys from config. No server proxy. Each destination is uploaded independently; a failure at one does not block or roll back the others.

## Config Contract

Config JSON is required at app startup. Key fields:
- `instant_app_id`
- `firebase_api_key`
- `email`
- `password`
- `root_master_key`
- `r2_config`: account id, bucket, access key id, secret access key
- `s3_config`: array of `{ endpoint, region, bucket, access key id, secret access key }`, one entry per S3 compatible destination

## Docs

- `docs/architecture.md` - architectural decisions
- `docs/tech_stack.md` - technologies and project layout
- `docs/data_model.md` - InstantDB entities, links, permission rules
- `docs/crypto.md` - cipher spec, key hierarchy, blob format v1.0
- `docs/security.md` - threat model and guarantees
- `docs/features.md` - feature surface
- `docs/testing.md` - testing strategy
