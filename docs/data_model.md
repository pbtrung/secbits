# Data Model

InstantDB entities, links, and permission rules. Every field beyond row id and the ownership link is an opaque encrypted blob; InstantDB never sees plaintext content. See docs/crypto.md for the key hierarchy that produces these blobs.

## Entities

`keyStore`
- `umkBlob` (string): base64 AEAD blob, the UMK (User Master Key) wrapped via HKDF+AEAD under `root_master_key`. One row per user.
- `backupKeyBlob` (string): base64 AEAD blob, the backup key wrapped via HKDF+AEAD under `root_master_key`, used only to encrypt cloud backups (see docs/crypto.md, Cloud Backup).

`entries`
- `entryKey` (string): base64 AEAD blob, 64 raw random bytes wrapped via HKDF+AEAD under the UMK. Generated once per entry.
- `encryptedData` (string): base64 AEAD blob, wrapped via HKDF+AEAD under the entry's `entryKey`, containing everything about the entry — type, title, fields, tags, notes, `createdAt`, `updatedAt`, `deletedAt` (trash marker)

`entryHistory`
- `encryptedSnapshot` (string): base64 AEAD blob, wrapped via HKDF+AEAD under the parent entry's `entryKey`, containing the commit hash, timestamp, and full entry snapshot at that commit

## Links

- `keyStore.owner` <-> `$users.keyStore` (one key store row per user); `onDelete: cascade` on the `$users` side, deleting a user's account deletes their `keyStore` row.
- `entries.owner` <-> `$users.entries` (many entries to one user); same cascade, deleting a user's account deletes their entries.
- `entryHistory.entry` <-> `entries.entryHistory` (many history rows to one entry); `onDelete: cascade` on the `entries` side, deleting an entry deletes its history rows automatically, so nothing needs to delete them separately.

These reverse label names (`keyStore`, `entries`, `entryHistory`) matter beyond cosmetics: `instant.schema.ts`'s `links` object needs to mirror them exactly, since InstantDB validates query link references against the schema object passed to `init()`, not against whatever is actually live on the backend. A mismatch there produces "Link 'x' does not exist" errors even when the link genuinely exists server side.

Pushing these through `npx instant-cli@latest push schema` hit a reproducible bug: any newly created link to `$users` fails validation with `connects to non existing entity`, regardless of entity name, casing, or link order, even once the target entity is otherwise proven to exist via other successful links, and even with an auth method already configured. Ruled out: casing, the specific entity name, missing `$users` declaration (it is never declared explicitly, confirmed against InstantDB's own docs), and auth not being set up. The three links above were instead created manually via the InstantDB dashboard's Explorer UI.

**Current state**: `instant.schema.ts` ships with `links: {}`, not mirroring the links above, by deliberate choice as of the most recent commit. Until `links` in that file is updated to match this section exactly, the running app will hit "Link 'owner' does not exist on entity 'keyStore'" at the `ensureKeyStore` step, since `db.js` passes that empty-links schema straight to `init()`.

## Permission rules (`instant.perms.ts`)

```
keyStore:
  view/create/delete → auth.id in data.ref('owner.id')
  update              → auth.id in data.ref('owner.id') && newData.owner == data.owner

entries:
  view/create/delete → auth.id in data.ref('owner.id')
  update              → auth.id in data.ref('owner.id') && newData.owner == data.owner

entryHistory:
  view/create → auth.id in data.ref('entry.owner.id')
  update       → false
  delete       → auth.id in data.ref('entry.owner.id')
```

InstantDB treats any action left unspecified as allow, not deny, so every action on every entity above must be listed explicitly. `entryHistory.update` is `false`: history snapshots are immutable, created or deleted, never modified.

`update` in InstantDB evaluates `data` against the pre update state and exposes the incoming write as `newData`, so `auth.id in data.ref('owner.id')` alone only proves the caller currently owns the row; it does not stop them reassigning `owner` to a different user's `$users` id in the same update. `instant.perms.ts` pins the ownership link with `newData.ref('owner.id') == data.ref('owner.id')`. This exact link comparison syntax is unverified: InstantDB's own documented example for this pattern (`newData.creatorId == data.creatorId`) compares a plain scalar attribute, not a link, so `.ref()` on both sides is a best effort extension of that pattern, not a confirmed one. Must be checked against a real InstantDB app (see docs/testing.md, Permission rules) before relying on it.

Deletion of old history rows and trashed entries is driven entirely by the client (see docs/architecture.md, Maintenance), since only the client can decrypt `createdAt`/`deletedAt` to decide what is old enough to remove. Permission rules allow it because it is still the owning user doing the deleting, not a privileged bypass.

## Uniqueness

"One `keyStore` row per user" is a design assumption, not an enforced invariant: InstantDB has no schema level one-to-one link constraint, and the permission rules above only govern access, not cardinality. A duplicate `keyStore` row for one user is possible, whether from the ownership reassignment gap above (before the fix) or an ordinary race, e.g. two tabs both finding no `keyStore` row on first run and both creating one before either sees the other's write. The app must treat first run `keyStore` creation as needing idempotency handling, and must treat finding more than one `keyStore` row for the current user as a fatal, user visible error rather than silently picking one, since silently picking wrong is indistinguishable from losing access to the vault.

## Multi user, no sharing

Every row (`keyStore`, `entries`, `entryHistory`) has exactly one `owner`/`entry` link, and no other link type exists that could grant a second user access. There is no `sharedWith` link, no organization or team entity, no public entries. Access is strictly one owner per row, enforced by the permission rules above.
