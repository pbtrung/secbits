# SecBits

End to end encrypted password manager. React and Vite frontend, Firebase Authentication for login, InstantDB as the database and session layer, no custom backend.

## Features

- Encrypted vault: every field of every entry, including type and timestamps, is end to end encrypted; InstantDB never sees plaintext (see docs/features.md, docs/crypto.md).
- History: every save keeps an immutable snapshot, capped at the most recent 20 commits per entry, verified with an embedded commit hash.
- Trash: soft delete with a client side retention purge.
- Backup: on demand local export as plain JSON, and on demand cloud backup, compressed and encrypted under a dedicated backup key, to Cloudflare R2 and any S3 compatible endpoint.
- Key rotation: rotate the root master key, the per user master key, or the backup key independently, without needing to re encrypt everything downstream.
- Multi user, no sharing: every user's data is strictly isolated; there is no mechanism to share an entry with another user (see docs/security.md for the full threat model).

See docs/features.md for the full, current feature surface, and what is still undecided.

## Architecture

React and Vite frontend deployed to Cloudflare Pages. Firebase Authentication handles email and password login; the resulting ID token is exchanged for an InstantDB session. InstantDB is both the database and the session layer, the client talks to it directly, scoped by permission rules, and there is no Worker or other custom backend. See docs/architecture.md, docs/data_model.md, and docs/crypto.md for the full design.

## Installation

Prerequisites: Node.js, a Firebase project with email and password authentication enabled, and an InstantDB app.

1. Clone the repository and install dependencies:
   ```bash
   git clone git@github.com:pbtrung/secbits.git
   cd secbits
   npm install
   ```
2. Register the Firebase project with InstantDB, so InstantDB can verify Firebase issued tokens (see docs/architecture.md, Auth: Firebase through InstantDB). This gives you a client name to put in config.
3. Push the schema and permission rules to your InstantDB app:
   ```bash
   npx instant-cli@latest push schema
   npx instant-cli@latest push perms
   ```
4. For cloud backup, create a Cloudflare R2 bucket and, optionally, a bucket on any S3 compatible provider, and enable CORS on each for the app's origin (see docs/tech_stack.md).
5. Provide a config JSON with the fields listed in CLAUDE.md, Config Contract: `instant_app_id`, `firebase_api_key`, `email`, `password`, `root_master_key`, and, if using cloud backup, `r2_config` and `s3_config`. The exact delivery mechanism for this config, environment variable, uploaded file, or something else, is not yet decided.

   ```json
   {
     "instant_app_id": "00000000-0000-0000-0000-000000000000",
     "firebase_api_key": "AIzaSyXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
     "email": "you@example.com",
     "password": "REPLACE_WITH_FIREBASE_PASSWORD",
     "root_master_key": "REPLACE_WITH_BASE64_ENCODED_256_PLUS_BYTE_SECRET",
     "r2_config": {
       "account_id": "REPLACE_WITH_CLOUDFLARE_ACCOUNT_ID",
       "bucket": "secbits-backup",
       "access_key_id": "REPLACE_WITH_R2_ACCESS_KEY_ID",
       "secret_access_key": "REPLACE_WITH_R2_SECRET_ACCESS_KEY"
     },
     "s3_config": [
       {
         "endpoint": "https://s3.us-west-1.amazonaws.com",
         "region": "us-west-1",
         "bucket": "secbits-backup",
         "access_key_id": "REPLACE_WITH_S3_ACCESS_KEY_ID",
         "secret_access_key": "REPLACE_WITH_S3_SECRET_ACCESS_KEY"
       },
       {
         "endpoint": "https://s3.us-west-000.backblazeb2.com",
         "region": "us-west-000",
         "bucket": "secbits-backup",
         "access_key_id": "REPLACE_WITH_OTHER_S3_ACCESS_KEY_ID",
         "secret_access_key": "REPLACE_WITH_OTHER_S3_SECRET_ACCESS_KEY"
       }
     ]
   }
   ```

   `r2_config` and `s3_config` are optional and only needed if cloud backup is used. `s3_config` is an array, one entry per S3 compatible destination, so the vault can back up to more than one S3 compatible provider at once.

## Usage

- Local development: `npm run dev` starts the Vite dev server against your real Firebase and InstantDB projects; there is no local emulator for either (see docs/tech_stack.md).
- Deployment: build and deploy the frontend to Cloudflare Pages; there is nothing else to deploy, no server component exists.
- Login is automatic on startup using the email and password from config, no interactive step.
- Add, edit, tag, and search entries; every save keeps a history entry automatically.
- Trash and restore entries; trashed entries are purged automatically after the retention window.
- Back up the vault on demand, locally as plain JSON, or to configured cloud storage, encrypted.
- Rotate the root master key, the per user master key, or the backup key from settings if you suspect a compromise (see docs/security.md, Recovery).

## Docs

- `docs/architecture.md` - architectural decisions
- `docs/tech_stack.md` - technologies and project layout
- `docs/data_model.md` - InstantDB entities, links, permission rules
- `docs/crypto.md` - cipher spec, key hierarchy, blob format v1.0
- `docs/security.md` - threat model and guarantees
- `docs/features.md` - feature surface
- `docs/testing.md` - testing strategy
