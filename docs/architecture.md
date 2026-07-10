# Architecture

SecBits is a client heavy, end to end encrypted password manager. There is no custom backend: after the auth handshake below, the server side never sees anything but opaque encrypted blobs.

## Backend: none, by design

- InstantDB is both the database and the session layer. The client talks to InstantDB directly for reads and writes; there is no Worker, no custom CRUD API, no admin token anywhere in the stack.
- Row level access is enforced entirely by InstantDB permission rules (`instant.perms.ts`), scoping every row to the authenticated `auth.id`.
- Every field on every entity is encrypted client side, including timestamps and type. The only plaintext InstantDB ever sees is row ids and the owner/entry links needed to scope access; those reveal that a row exists and who owns it, nothing about its content.

## Auth: Firebase through InstantDB

InstantDB's Firebase integration is used instead of InstantDB's native magic code auth, to keep the fully automated, config driven login the app relies on:

1. Firebase project is registered with InstantDB (project id plus a chosen client name) so InstantDB can verify Firebase issued tokens.
2. App calls Firebase's `signInWithEmailAndPassword` using the email and password from the local config file. No interactive step.
3. App retrieves the Firebase ID token and calls `db.auth.signInWithIdToken({ idToken, clientName })`.
4. InstantDB verifies the token's signature, looks up or creates its own `$users` row keyed by the email in the token claims, and starts a long lived InstantDB session.
5. All subsequent permission rules scope on InstantDB's own `auth.id`; no separate derived user id is needed.

## Maintenance: client side

Because every field is encrypted, nothing server side can read timestamps or trash state, so there is no cron job. Instead, the client does this work itself during normal use:
- History cap: after adding a new history row, decrypt the entry's linked history rows, sort by their embedded timestamp, delete any past the most recent N.
- Trash purge: on load, decrypt trashed entries' embedded `deletedAt`, permanently delete any past the retention window.

## Data model

See docs/data_model.md.

## Crypto

See docs/crypto.md: Ascon-Keccak-512 AEAD via leancrypto WASM, HKDF-SHA3-512 key derivation, a three level key hierarchy rooted at `root_master_key`. Every field beyond row id and ownership link is end to end encrypted client side.
