# Data Model

InstantDB entities, links, and permission rules. Every field beyond row id and the ownership link is an opaque encrypted blob; InstantDB never sees plaintext content.

## Key hierarchy

```text
root_master_key (config)
  └── HKDF+AEAD → keyStore.umkBlob
        └── HKDF+AEAD → entries.entryKey blob (64 raw random bytes, one per entry)
              ├── HKDF+AEAD → entries.encryptedData
              └── HKDF+AEAD → entryHistory.encryptedSnapshot
```

`root_master_key` lives only in local config; it never touches InstantDB. Each level wraps the key below it with a fresh HKDF+AEAD pass, so rotating `root_master_key` only re-encrypts `keyStore.umkBlob`, and rotating a single entry only re-encrypts that entry's `entryKey` blob — neither requires touching every row.

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
  view/create/update/delete → auth.id in data.ref('owner.id')

entries:
  view/create/update/delete → auth.id in data.ref('owner.id')

entryHistory:
  view/create/delete        → auth.id in data.ref('entry.owner.id')
```

Deletion of old history rows and trashed entries is driven entirely by the client (see docs/architecture.md, Maintenance), since only the client can decrypt `createdAt`/`deletedAt` to decide what is old enough to remove. Permission rules allow it because it is still the owning user doing the deleting, not a privileged bypass.

## Multi user, no sharing

Every row (`keyStore`, `entries`, `entryHistory`) has exactly one `owner`/`entry` link, and no other link type exists that could grant a second user access. There is no `sharedWith` link, no organization or team entity, no public entries. Access is strictly one owner per row, enforced by the permission rules above.
