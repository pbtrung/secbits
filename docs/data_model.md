# Data Model

InstantDB entities, links, and permission rules. Every field beyond row id and the ownership link is an opaque encrypted blob, whether stored as a database field or as an InstantDB Storage file; InstantDB never sees plaintext content. See docs/crypto.md for the key hierarchy that produces these blobs.

## Entities

`$users` is declared explicitly in `instant.schema.ts` (`email`, `imageURL`, `type`, matching what InstantDB's own pull of this app's live schema shows), even though this app never writes to it directly. This is required, not cosmetic: a `where` filter using dot notation through a link into `$users` (e.g. `'owner.id'`) fails validation with "Target entity '$users' does not exist in schema" if `$users` is not declared locally, even though the link to it works fine on its own without this.

`ensureKeyStore` still queries `$users` directly, by its own id, to find the caller's `umkStore` row. `fetchUserEntries` and `rotateUserMasterKey` no longer go through `$users` at all; entries scope through `umkStore` now (see Links below).

`umkStore`

- `umkBlob` (string): base64 AEAD blob, the UMK (User Master Key) wrapped via HKDF+AEAD under `root_master_key`. One row per user.

Cloud backups are encrypted under `backup_master_key`, a config only secret that never touches InstantDB in any form (see docs/crypto.md, Key Hierarchy); there is no `umkStore` row for it.

`entries`

- `entryKeyBlob` (string): base64 AEAD blob, 64 raw random bytes wrapped via HKDF+AEAD under the UMK. Generated once per entry.
- `entryFile`: link to a `$files` row (see below), one-to-one, `onDelete: cascade`. Replaces the old `encryptedData` string field and the old separate `entryHistory` table both — an entry's current data and its entire history live in this one linked file, nothing else.

`$files` (InstantDB Storage, see https://instantdb.com/docs/storage)

- One file per entry, an AEAD blob uploaded as raw bytes, never a base64 string in a database field (see docs/crypto.md, Encryption Pipeline), wrapped via HKDF+AEAD under the entry's `entryKeyBlob`. Its plaintext is a JSON array of every kept commit (`commitHash`, timestamp, full entry snapshot at that commit), newest first. There is no `entryHistory` table, no per-commit row, and no second file for history: the entry's current state is simply the newest commit (`array[0]`), the rest is its history.
- `path` is `${auth.id}/entries/${entryId}/${commitHash}.json`, where `commitHash` is the newest commit's hash — every save gets a fresh path, nothing is ever overwritten in place (see docs/crypto.md, Entry Data File).

## Links

- `umkStore.owner` <-> `$users.umkStore` (one UMK row per user), `has: 'one'` on both sides — see Uniqueness below: this exact shape produced a persistent "already exists" rejection once before, and this is a deliberate retry, not a first attempt; `onDelete: cascade` on the `umkStore` side, deleting a user's account deletes their `umkStore` row.
- `entries.umk` <-> `umkStore.entries` (many entries to one `umkStore` row — an entry's owner is whoever owns that `umkStore` row, transitively via `umkStore.owner` above), `has: 'one'` on the `entries` side / `has: 'many'` on the `umkStore` side, `required: true`, `onDelete: cascade` on the `entries` side, deleting a `umkStore` row deletes its linked entries. Replaces the old direct `entries.owner` <-> `$users.entries` link entirely: entries no longer link to `$users` at all, only to their own `umkStore` row. One fewer link targeting `$users`, which is exactly where the `connects to non existing entity` push bug below always hit.
- `entries.entryFile` <-> `$files.entry` (one file per entry, holding both current data and full history), `has: 'one'` on both sides, `onDelete: cascade`, deleting an entry deletes its file automatically. Every save uploads the new file at a fresh path, then in one atomic `db.transact` call deletes the previous file and links the new one — a genuine `has: 'one'`/`has: 'one'` link is safe here because that swap is a single atomic step: there is never an externally observable moment with zero or two files linked to the entry. No `required: true` on this forward link, unlike `entries.umk` above: the `$files` row is created by a separate Storage upload call before the `db.transact` that links it, so for a moment after upload the file exists unlinked, which a `required` constraint could reject.

Two things about the two-hop `entries -> umkStore -> $users` scoping are assumed, not confirmed, pending a live push and test: whether `data.ref('umk.owner.id')` (a two-hop ref) resolves correctly in a `create` rule when the first hop (`umk`) is being set in that very same transact rather than already existing beforehand; and whether deleting a `$users` row now cascades two levels deep (`$users` → `umkStore` → `entries`) or InstantDB only cascades one hop per delete. Neither of these has failed, they simply haven't been exercised against a live app yet.

These reverse label names (`umkStore`, `entries`, `entryFile`) matter beyond cosmetics: `instant.schema.ts`'s `links` object needs to mirror them exactly, since InstantDB validates query link references against the schema object passed to `init()`, not against whatever is actually live on the backend. A mismatch there produces "Link 'x' does not exist" errors even when the link genuinely exists server side.

Pushing these through `npx instant-cli@latest push schema` hit a reproducible bug: any newly created link to `$users` fails validation with `connects to non existing entity`, regardless of entity name, casing, or link order, even once the target entity is otherwise proven to exist via other successful links, and even with an auth method already configured. Ruled out: casing, the specific entity name, missing `$users` declaration (it is never declared explicitly, confirmed against InstantDB's own docs), and auth not being set up. The links touching `$users` were instead created manually via the InstantDB dashboard's Explorer UI.

`instant.schema.ts`'s `links` object mirrors the three links above exactly. If it is ever reverted to `links: {}` (which happened once already, deliberately, and reintroduced the exact failure this section describes), the running app breaks at the `ensureKeyStore` step with "Link 'owner' does not exist on entity 'umkStore'", since `db.ts` passes that schema straight to `init()`. That is not a `db.ts` bug; `db.ts`'s query logic is correct and unaffected either way, the fix is always to restore `links` here to match this section.

## Permission rules (`instant.perms.ts`)

```
umkStore:
  view/create/delete → auth.id in data.ref('owner.id')
  update              → auth.id in data.ref('owner.id') && !('owner' in request.modifiedFields)

entries:
  view/create/delete → auth.id in data.ref('umk.owner.id')
  update              → auth.id in data.ref('umk.owner.id') && !('umk' in request.modifiedFields)

$files:
  view/create/delete → data.path.startsWith(auth.id + '/')
  update              → false
```

InstantDB treats any action left unspecified as allow, not deny, so every action on every entity above must be listed explicitly. `$files.update` is `false`: a file is only ever created fresh at a new path or deleted, never edited in place (see docs/crypto.md, Entry Data File) — nothing in this app calls `db.transact` to edit an existing `$files` row's `path`/custom columns. Storage permissions scope on `data.path` rather than `data.ref`, so the `auth.id` prefix in the path (see Entities above) is what stands in for the ownership check on `entries`/`umkStore` (`data.ref('owner.id')` for `umkStore`, the two-hop `data.ref('umk.owner.id')` for `entries`).

`update` in InstantDB evaluates `data` against the pre update state and exposes the incoming write as `newData`, so `auth.id in data.ref(...)` alone only proves the caller currently owns the row through its _current_ link; it does not stop them reassigning that link to point somewhere else in the same update (`owner` for `umkStore`, `umk` for `entries`). An earlier version of this rule tried to pin the link with `newData.ref('owner.id') == data.ref('owner.id')`, which failed live with "Could not evaluate permission rule ... You may have a typo." `newData.ref(...)` is unsupported entirely, confirmed against InstantDB's own docs; their documented pattern for pinning a field across an update, `newData.creatorId == data.creatorId`, only covers a plain scalar attribute, not a link. The correct mechanism for a link is `request.modifiedFields`, a list of field names actually being changed in the transaction: `!('owner' in request.modifiedFields)` (`umkStore`) / `!('umk' in request.modifiedFields)` (`entries`) denies the update outright if that link is among the changed fields, regardless of what value it would be changed to, rather than trying to compare old and new link values directly.

Deletion of superseded entry files and trashed entries is driven entirely by the client (see docs/architecture.md, Maintenance), since only the client can decrypt `createdAt`/`deletedAt` to decide what is old enough to remove. Permission rules allow it because it is still the owning user doing the deleting, not a privileged bypass.

## Uniqueness

"One `umkStore` row per user" is enforced client side, and — as of this retry — also declared at the schema level via `has: 'one'` on both sides of `umkStoreOwner`. A genuine `has: 'one'`/`has: 'one'` link on this exact relationship was tried once before and produced a persistent "already exists" uniqueness rejection on `owner`, even after confirming zero existing rows, no leftover entities from diagnostic renames, and correct auth settling to the right user; deleting and recreating the link fresh (rather than editing cardinality in place) did not resolve it either. Backend enforcement was backed off to `has: 'many'` on the `$users` side at that point. This is a deliberate retry of the original `has: 'one'`/`has: 'one'` shape, not a fresh attempt uninformed by that history — if the same rejection recurs, the known fallback is exactly what shipped before: `has: 'many'` on the `$users` side, cardinality enforced client side. `ensureKeyStore`/`findOwnUmkStoreRow` in `src/db.ts` no longer contain a "more than one row" check either way: under a genuine `has: 'one'` constraint there is nothing to check (the query's own type only ever allows zero or one), so this is either enforced by the schema now, or, if the fallback is needed again, the equivalent client-side check comes back with it.

Along the way, one real, separate bug was found and fixed regardless of whether it was the actual cause: `db.getAuth()` does not read InstantDB's in-memory auth state directly, it reads back through `_getCurrentUser` from a persisted key-value store (`this.kv.waitForKeyToLoad`). There is a genuine window right after `signInWithIdToken()` resolves where `getAuth()` can return nothing yet. `signIn()` in `src/db.ts` now waits for `db.getAuth()` to return something before trusting it elsewhere. It only warns, does not throw, on an `email` mismatch against the Firebase credential just used, since `email` is optional on `$users` and may not be reliably populated even on a correct session; an earlier version of this check treated a mismatch as fatal and produced a false failure on a session that was actually fine.

`instant.schema.ts` is now treated as a mirror of `npx instant-cli@latest pull schema`'s output rather than hand-maintained from this document, after the hand-maintained version drifting from what was actually live caused several of the bugs described above (a missing `$users` declaration, a reverse label mismatch, an outright empty `links: {}` reintroduced by a revert). It includes `$files`, no longer just a schema internal now that entry data and history live there (see Entities above), and the `$usersLinkedPrimaryUser` system link, an InstantDB internal this app never touches directly, kept only because the query validator needs local schema for anything a dot notation `where` filter traverses into.

**Confirmed root cause**: `db.queryOnce()`'s result is wrapped in a `data` key, e.g. `{ data: { $users: [...] } }`, not the bare query shape `{ $users: [...] }`. Every `queryOnce` call site in `src/db.ts` read the unwrapped shape (`response.$users` instead of `response.data.$users`), so every one of them always saw `undefined` and fell back to an empty array, regardless of what query shape was tried or what actually existed on the backend. This is why `ensureKeyStore` always concluded zero `umkStore` rows existed and created a new one on every login, no matter which of the three query strategies described above was used, since the bug was in reading the response, not in the query itself. Confirmed via diagnostic logging of the raw response before this fix; typing these calls against the schema (see docs/tech_stack.md, Types) makes this exact class of bug a compile-time error going forward, not just a caught-in-review one.

Every `queryOnce` call site in `src/db.ts` at the time, six of them across `ensureKeyStore`, `fetchUserEntries`, `deleteUserEntry`, `restoreDeletedUserEntry`, `restoreVersionByCommitHash`, and `rotateUserMasterKey`, needed the same `.data.<key>` fix, not just the `umkStore` lookup: `fetchUserEntries` would have always seen zero entries too, meaning the vault would have appeared empty on every load even with real entries present, had this gone unnoticed any further. The storage redesign has since consolidated several of those call sites into shared helpers (`queryOwnUmkStoreRow`, `fetchCurrentEntryFile`, `fetchCurrentHistoryArray`), so the current call site count is lower than six; the point stands regardless of the exact count: any `queryOnce` call anywhere in this file must read `.data.<key>`, not `.<key>`.

## Multi user, no sharing

Every `umkStore` row has exactly one `owner` link; every `entries` row has exactly one `umk` link to its owner's `umkStore` row, so its ownership is transitive rather than direct; and every `$files` row has exactly one `entry` link plus a path namespaced under its owner's `auth.id`. No other link type exists that could grant a second user access. There is no `sharedWith` link, no organization or team entity, no public entries. Access is strictly one owner per row (directly or transitively), enforced by the permission rules above.
