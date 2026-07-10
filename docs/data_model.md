# Data Model

InstantDB entities, links, and permission rules. Every field beyond row id and the ownership link is an opaque encrypted blob; InstantDB never sees plaintext content. See docs/crypto.md for the key hierarchy that produces these blobs.

## Entities

`$users` is declared explicitly in `instant.schema.ts` (`email`, `imageURL`, `type`, matching what InstantDB's own pull of this app's live schema shows), even though this app never writes to it directly. This is required, not cosmetic: a `where` filter using dot notation through a link into `$users` (e.g. `'owner.id'`, used by `ensureKeyStore`/`fetchUserEntries`/`rotateUserMasterKey` to scope queries to the caller) fails validation with "Target entity '$users' does not exist in schema" if `$users` isn't declared locally, even though the link to it works fine on its own without this.

`keyStore`
- `umkBlob` (string): base64 AEAD blob, the UMK (User Master Key) wrapped via HKDF+AEAD under `root_master_key`. One row per user.
- `backupKeyBlob` (string): base64 AEAD blob, the backup key wrapped via HKDF+AEAD under `root_master_key`, used only to encrypt cloud backups (see docs/crypto.md, Cloud Backup).

`entries`
- `entryKey` (string): base64 AEAD blob, 64 raw random bytes wrapped via HKDF+AEAD under the UMK. Generated once per entry.
- `encryptedData` (string): base64 AEAD blob, wrapped via HKDF+AEAD under the entry's `entryKey`, containing everything about the entry — type, title, fields, tags, notes, `createdAt`, `updatedAt`, `deletedAt` (trash marker)

`entryHistory`
- `encryptedSnapshot` (string): base64 AEAD blob, wrapped via HKDF+AEAD under the parent entry's `entryKey`, containing the commit hash, timestamp, and full entry snapshot at that commit

## Links

- `keyStore.owner` <-> `$users.keyStore` (one key store row per user, `has: 'one'` on both sides so InstantDB itself rejects a second link, not just an app level convention); `onDelete: cascade` on the `$users` side, deleting a user's account deletes their `keyStore` row.
- `entries.owner` <-> `$users.entries` (many entries to one user); same cascade, deleting a user's account deletes their entries.
- `entryHistory.entry` <-> `entries.entryHistory` (many history rows to one entry); `onDelete: cascade` on the `entries` side, deleting an entry deletes its history rows automatically, so nothing needs to delete them separately.

These reverse label names (`keyStore`, `entries`, `entryHistory`) matter beyond cosmetics: `instant.schema.ts`'s `links` object needs to mirror them exactly, since InstantDB validates query link references against the schema object passed to `init()`, not against whatever is actually live on the backend. A mismatch there produces "Link 'x' does not exist" errors even when the link genuinely exists server side.

Pushing these through `npx instant-cli@latest push schema` hit a reproducible bug: any newly created link to `$users` fails validation with `connects to non existing entity`, regardless of entity name, casing, or link order, even once the target entity is otherwise proven to exist via other successful links, and even with an auth method already configured. Ruled out: casing, the specific entity name, missing `$users` declaration (it is never declared explicitly, confirmed against InstantDB's own docs), and auth not being set up. The three links above were instead created manually via the InstantDB dashboard's Explorer UI.

`instant.schema.ts`'s `links` object mirrors the three links above exactly. If it is ever reverted to `links: {}` (which happened once already, deliberately, and reintroduced the exact failure this section describes), the running app breaks at the `ensureKeyStore` step with "Link 'owner' does not exist on entity 'keyStore'", since `db.js` passes that schema straight to `init()`. That is not a `db.js` bug; `db.js`'s query logic is correct and unaffected either way, the fix is always to restore `links` here to match this section.

## Permission rules (`instant.perms.ts`)

```
keyStore:
  view/create/delete → auth.id in data.ref('owner.id')
  update              → auth.id in data.ref('owner.id') && newData.ref('owner.id') == data.ref('owner.id')

entries:
  view/create/delete → auth.id in data.ref('owner.id')
  update              → auth.id in data.ref('owner.id') && newData.ref('owner.id') == data.ref('owner.id')

entryHistory:
  view/create → auth.id in data.ref('entry.owner.id')
  update       → false
  delete       → auth.id in data.ref('entry.owner.id')
```

InstantDB treats any action left unspecified as allow, not deny, so every action on every entity above must be listed explicitly. `entryHistory.update` is `false`: history snapshots are immutable, created or deleted, never modified.

`update` in InstantDB evaluates `data` against the pre update state and exposes the incoming write as `newData`, so `auth.id in data.ref('owner.id')` alone only proves the caller currently owns the row; it does not stop them reassigning `owner` to a different user's `$users` id in the same update. `instant.perms.ts` pins the ownership link with `newData.ref('owner.id') == data.ref('owner.id')`. This exact link comparison syntax is unverified: InstantDB's own documented example for this pattern (`newData.creatorId == data.creatorId`) compares a plain scalar attribute, not a link, so `.ref()` on both sides is a best effort extension of that pattern, not a confirmed one. Must be checked against a real InstantDB app (see docs/testing.md, Permission rules) before relying on it.

Deletion of old history rows and trashed entries is driven entirely by the client (see docs/architecture.md, Maintenance), since only the client can decrypt `createdAt`/`deletedAt` to decide what is old enough to remove. Permission rules allow it because it is still the owning user doing the deleting, not a privileged bypass.

## Uniqueness

"One `keyStore` row per user" is enforced at the schema level: `keyStoreOwner`'s link is `has: 'one'` on both the `keyStore` side and the `$users` side, so InstantDB itself should reject creating a second `keyStore` linked to a `$users` that already has one, not just rely on app level convention. This corrects an earlier version of this doc that assumed InstantDB had no such constraint; setting both sides of a link to `has: 'one'` does enforce it. This still needs live verification, and the schema change on the dashboard side must have any existing duplicate `keyStore` rows for a user cleaned up first, since InstantDB is unlikely to let a stricter constraint apply over data that already violates it.

Root cause of the observed bug (a new `keyStore` row created on every login, one stable `$users` row underneath) is still not fully confirmed. `ensureKeyStore`'s original query was `{ keyStore: {} }`, an unscoped query relying entirely on the `view` permission rule to implicitly filter results down to the caller's own row; that assumption was wrong somewhere, since the same stable user kept seeing zero rows on each login despite one already existing. Switching to an explicit `{ keyStore: { $: { where: { 'owner.id': authId } } } }` where filter did not resolve it, nor did switching to a `$users`-first, follow-the-link query instead: after confirming zero existing `keyStore` rows and no leftover entities from earlier diagnostic renames, creating a fresh row still failed with a uniqueness violation on `owner`.

One real contributing factor found and fixed: `db.getAuth()` does not read InstantDB's in-memory auth state directly, it reads back through `_getCurrentUser` from a persisted key-value store (`this.kv.waitForKeyToLoad`). There is a genuine window right after `signInWithIdToken()` resolves where `getAuth()` can still return a stale previous session's user, which would make every query/mutation in that window operate as the wrong user. `signIn()` in `src/db.js` now polls `db.getAuth()` after sign in (up to 10 tries, 200ms apart) until its `email` matches the Firebase credential just used, throwing rather than silently proceeding if it never settles. Whether this was the actual cause of the duplicate `keyStore` rows, or just a real bug found along the way, is not yet confirmed.

Current approach (also unconfirmed): query from `$users` (whose id is already known from `auth.id`) and follow the forward link out to `keyStore`/`entries`, rather than querying `keyStore`/`entries` with a reverse dot-path filter, e.g. `{ $users: { $: { where: { id: authId } }, keyStore: {} } }`. This is a different code path in InstantDB's query engine than the reverse filter approach; `ensureKeyStore`, `fetchUserEntries`, and `rotateUserMasterKey` all use it now. Needs live verification.

The app still treats finding more than one `keyStore` row for the current user as a fatal, user visible error rather than silently picking one, as defense in depth: the schema constraint should make this unreachable going forward, but it doesn't retroactively fix rows created before the constraint was tightened, and a bug in enforcement should fail loudly rather than silently corrupt vault access.

## Multi user, no sharing

Every row (`keyStore`, `entries`, `entryHistory`) has exactly one `owner`/`entry` link, and no other link type exists that could grant a second user access. There is no `sharedWith` link, no organization or team entity, no public entries. Access is strictly one owner per row, enforced by the permission rules above.
