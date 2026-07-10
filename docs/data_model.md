# Data Model

InstantDB entities, links, and permission rules. Every field beyond row id and the ownership link is an opaque encrypted blob; InstantDB never sees plaintext content. See docs/crypto.md for the key hierarchy that produces these blobs.

## Entities

`keyStore`
- `umkBlob` (string): base64 AEAD blob, the UMK (User Master Key) wrapped via HKDF+AEAD under `root_master_key`. One row per user.

`entries`
- `entryKey` (string): base64 AEAD blob, 64 raw random bytes wrapped via HKDF+AEAD under the UMK. Generated once per entry.
- `encryptedData` (string): base64 AEAD blob, wrapped via HKDF+AEAD under the entry's `entryKey`, containing everything about the entry — type, title, fields, tags, notes, `createdAt`, `updatedAt`, `deletedAt` (trash marker)

`entryHistory`
- `encryptedSnapshot` (string): base64 AEAD blob, wrapped via HKDF+AEAD under the parent entry's `entryKey`, containing the commit hash, timestamp, and full entry snapshot at that commit

## Links

- `keyStore.owner` <-> `$users` (one key store row per user)
- `entries.owner` <-> `$users` (many entries to one user)
- `entryHistory.entry` <-> `entries` (many history rows to one entry)

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

`update` in InstantDB evaluates `data` against the pre update state and exposes the incoming write as `newData`, so `auth.id in data.ref('owner.id')` alone only proves the caller currently owns the row; it does not stop them reassigning `owner` to a different user's `$users` id in the same update. The `newData.owner == data.owner` clause pins the ownership link so it cannot change after creation. The exact syntax for comparing a link field (not a plain attribute) across `data`/`newData` needs to be confirmed against InstantDB's current permissions API when `instant.perms.ts` is actually written; the InstantDB docs' own example for this pattern (`newData.creatorId == data.creatorId`) uses a plain scalar attribute, not a link, so verify link comparison works the same way before relying on it.

Deletion of old history rows and trashed entries is driven entirely by the client (see docs/architecture.md, Maintenance), since only the client can decrypt `createdAt`/`deletedAt` to decide what is old enough to remove. Permission rules allow it because it is still the owning user doing the deleting, not a privileged bypass.

## Uniqueness

"One `keyStore` row per user" is a design assumption, not an enforced invariant: InstantDB has no schema level one-to-one link constraint, and the permission rules above only govern access, not cardinality. A duplicate `keyStore` row for one user is possible, whether from the ownership reassignment gap above (before the fix) or an ordinary race, e.g. two tabs both finding no `keyStore` row on first run and both creating one before either sees the other's write. The app must treat first run `keyStore` creation as needing idempotency handling, and must treat finding more than one `keyStore` row for the current user as a fatal, user visible error rather than silently picking one, since silently picking wrong is indistinguishable from losing access to the vault.

## Multi user, no sharing

Every row (`keyStore`, `entries`, `entryHistory`) has exactly one `owner`/`entry` link, and no other link type exists that could grant a second user access. There is no `sharedWith` link, no organization or team entity, no public entries. Access is strictly one owner per row, enforced by the permission rules above.
