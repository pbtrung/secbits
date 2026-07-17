# SecBits

End to end encrypted password manager.

Stack:

- Frontend: React + Vite + TypeScript, deployed to Cloudflare Pages
- Auth: Firebase Authentication (email/password) exchanged for an InstantDB session via `db.auth.signInWithIdToken`
- Database: InstantDB (client writes directly, scoped by permission rules)

There is no custom backend. The frontend talks directly to Firebase (auth) and InstantDB (session and data); all maintenance (history cap, trash purge) runs client side since every field, including timestamps, is encrypted and the server never holds decryption keys.

## Code style

- TypeScript throughout `src/`; `strict` mode, no unchecked `any` at API boundaries (see docs/tech_stack.md for `tsconfig.json`/`npm run typecheck`).
- Prettier formats the whole repo, TS/JS/JSX/CSS/JSON/Markdown alike; `npm run format` to apply, `npm run format:check` to verify.
- Keep function bodies at 15 lines or fewer; extract a named helper rather than let a function grow past that. Applies to logic (handlers, data/crypto functions, helpers) — React component render bodies are exempt, since their length is markup, not logic, and splitting JSX purely to hit a line count scatters related UI across arbitrary fragments.

## Layout

```text
src/
  App.tsx          session gate (App) + vault layout/render (MainApp)
  db.ts            InstantDB client init and queries
  crypto.ts        per-entry encrypt/decrypt pipeline
  types.ts         shared domain types (Entry, ExportData, ConfigContract, ...)
  hooks/           useVaultState: entries/trash/selection/editing state and handlers behind App.tsx's render
  components/      UI components (.tsx)
  tests/           Vitest test suites (.test.ts)
instant.schema.ts  InstantDB entity and link definitions
instant.perms.ts   InstantDB permission rules
```

## Runtime Flow

Login:

1. App authenticates with Firebase using email and password from config.
2. App retrieves the Firebase ID token and exchanges it for an InstantDB session via `db.auth.signInWithIdToken`.
3. App fetches its own `umkStore` row, then the entries linked to it — entries scope to a user transitively through that row, not via a direct link — both scoped by InstantDB permission rules on `auth.id`.
4. App decrypts each entry's data file and loads the vault.

Save (create or update):

1. App serializes entry to JSON, including type, tags, and timestamps — everything.
2. App computes the commit hash over the serialized entry, decrypts the entry's current file if one exists to get its prior commit array, and prepends the new commit, capped at the most recent 20.
3. App Brotli compresses and AEAD encrypts the whole array as one blob (fresh salt), uploads it to a fresh path via `db.storage.uploadFile`, then, in one atomic `db.transact` call, deletes the entry's previous file and links the new one as `entryFile` (on create, the same call also writes `entryKeyBlob` and links `umk` to the user's own `umkStore` row).
4. InstantDB permission rules confirm every row and file path belong to the authenticated user throughout.

Maintenance (client side, on load/save):

1. App decrypts an entry's file (a single InstantDB Storage object holding a JSON array of every kept commit) to read each commit's embedded timestamp.
2. App drops the oldest commits past the cap of the most recent 20, re-encrypts and re-uploads the file at a new path, then atomically deletes the old file and links the new one.
3. App decrypts trashed entries' embedded `deletedAt` and permanently deletes those past the retention window.

Backup (on demand):

1. Local: App decrypts every entry and lets the user download the full vault as plain, unencrypted JSON. No encryption pipeline involved.
2. Cloud: App assembles the same plain JSON, Brotli compresses it, AEAD encrypts it under `backup_master_key` from config (fresh salt, current format version), and uploads it directly from the client to Cloudflare R2 and to each configured S3 compatible endpoint using access keys from config. No server proxy. Each destination is uploaded independently; a failure at one does not block or roll back the others.

## Config Contract

Config JSON is required at app startup. Key fields:

- `instant_app_id`
- `instant_client_name`: registered when linking Firebase to InstantDB; required by `db.auth.signInWithIdToken`
- `firebase_api_key`
- `email`
- `password`
- `root_master_key`
- `username`: shown in the UI for display only; plays no role in authentication or in scoping InstantDB rows
- `backup_master_key`: encrypts cloud backups; required only if `r2_config` or `s3_config` is set. Lives only in config, never wrapped or stored in InstantDB in any form, so a cloud backup stays decryptable even if InstantDB itself is lost
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
