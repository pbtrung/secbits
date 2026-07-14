# Data Model

InstantDB entities, links, and permission rules. Every field beyond row id and the ownership link is an opaque encrypted blob, whether stored as a database field or as an InstantDB Storage file; InstantDB never sees plaintext content. See docs/crypto.md for the key hierarchy that produces these blobs.

## Entities

`$users` is declared explicitly in `instant.schema.ts` (`email`, `imageURL`, `type`, matching what InstantDB's own pull of this app's live schema shows), even though this app never writes to it directly. This is required, not cosmetic: a `where` filter using dot notation through a link into `$users` (e.g. `'owner.id'`, used by `ensureKeyStore`/`fetchUserEntries`/`rotateUserMasterKey` to scope queries to the caller) fails validation with "Target entity '$users' does not exist in schema" if `$users` isn't declared locally, even though the link to it works fine on its own without this.

`keyStore`

- `umkBlob` (string): base64 AEAD blob, the UMK (User Master Key) wrapped via HKDF+AEAD under `root_master_key`. One row per user.

Cloud backups are encrypted under `backup_master_key`, a config only secret that never touches InstantDB in any form (see docs/crypto.md, Key Hierarchy); there is no `keyStore` field for it.

`entries`

- `entryKey` (string): base64 AEAD blob, 64 raw random bytes wrapped via HKDF+AEAD under the UMK. Generated once per entry.
- `encryptedData` (string): base64 AEAD blob, wrapped via HKDF+AEAD under the entry's `entryKey`, containing everything about the entry — type, title, fields, tags, notes, `createdAt`, `updatedAt`, `deletedAt` (trash marker)

`$files` (InstantDB Storage, see https://instantdb.com/docs/storage)

- One file per entry holds that entry's entire history: a single AEAD blob, wrapped via HKDF+AEAD under the parent entry's `entryKey` (same key as `encryptedData`, see docs/crypto.md, History File), whose plaintext is a JSON array of every kept commit (`commitHash`, timestamp, full entry snapshot at that commit).
- There is no `entryHistory` table. A commit is never its own row; the whole commit array is one Storage object, uploaded and read as raw bytes via `db.storage.uploadFile`/the file's `url`, not a base64 string in a database field (see docs/crypto.md, Encryption Pipeline).
- `path` is namespaced `${auth.id}/entryHistory/${entryId}/${latestCommitHash}.json`, so every save produces a new path (the latest commit hash always changes) instead of overwriting an existing object; see Permission rules below for why.

## Links

- `keyStore.owner` <-> `$users.keyStore` (one key store row per user, `has: 'one'` on both sides so InstantDB itself rejects a second link, not just an app level convention); `onDelete: cascade` on the `$users` side, deleting a user's account deletes their `keyStore` row.
- `entries.owner` <-> `$users.entries` (many entries to one user); same cascade, deleting a user's account deletes their entries.
- `entries.historyFile` <-> `$files.entry` (an entry's current history file); `onDelete: cascade` set the same way as the other links here, deleting an entry deletes its linked history file automatically. `has: 'many'` on the `entries` reverse side, not `has: 'one'`, even though exactly one history file should exist per entry at steady state: each save uploads the new file (new path, see Entities above) and links it before deleting the old one, so there is a brief window with two `$files` rows linked to the same entry. This is the same defensive choice already made for `keyStore` (see Uniqueness below) — cardinality enforced client side, not by a schema constraint that would reject a valid in-flight state.

These reverse label names (`keyStore`, `entries`, `historyFile`) matter beyond cosmetics: `instant.schema.ts`'s `links` object needs to mirror them exactly, since InstantDB validates query link references against the schema object passed to `init()`, not against whatever is actually live on the backend. A mismatch there produces "Link 'x' does not exist" errors even when the link genuinely exists server side.

Pushing these through `npx instant-cli@latest push schema` hit a reproducible bug: any newly created link to `$users` fails validation with `connects to non existing entity`, regardless of entity name, casing, or link order, even once the target entity is otherwise proven to exist via other successful links, and even with an auth method already configured. Ruled out: casing, the specific entity name, missing `$users` declaration (it is never declared explicitly, confirmed against InstantDB's own docs), and auth not being set up. The three links above were instead created manually via the InstantDB dashboard's Explorer UI.

`instant.schema.ts`'s `links` object mirrors the three links above exactly. If it is ever reverted to `links: {}` (which happened once already, deliberately, and reintroduced the exact failure this section describes), the running app breaks at the `ensureKeyStore` step with "Link 'owner' does not exist on entity 'keyStore'", since `db.ts` passes that schema straight to `init()`. That is not a `db.ts` bug; `db.ts`'s query logic is correct and unaffected either way, the fix is always to restore `links` here to match this section.

## Permission rules (`instant.perms.ts`)

```
keyStore:
  view/create/delete → auth.id in data.ref('owner.id')
  update              → auth.id in data.ref('owner.id') && !('owner' in request.modifiedFields)

entries:
  view/create/delete → auth.id in data.ref('owner.id')
  update              → auth.id in data.ref('owner.id') && !('owner' in request.modifiedFields)

$files:
  view/create/delete → data.path.startsWith(auth.id + '/')
  update              → false
```

InstantDB treats any action left unspecified as allow, not deny, so every action on every entity above must be listed explicitly. `$files.update` is `false`: a history file is created fresh (new path, new commit hash) or deleted, never edited in place; see docs/crypto.md, History File, for why every save gets a new path instead of overwriting the current one. Storage permissions scope on `data.path` rather than `data.ref`, so the `auth.id` prefix in the path (see Entities above) is what stands in for the `entries`/`keyStore` rules' `data.ref('owner.id')` check.

`update` in InstantDB evaluates `data` against the pre update state and exposes the incoming write as `newData`, so `auth.id in data.ref('owner.id')` alone only proves the caller currently owns the row; it does not stop them reassigning `owner` to a different user's `$users` id in the same update. An earlier version of this rule tried to pin the link with `newData.ref('owner.id') == data.ref('owner.id')`, which failed live with "Could not evaluate permission rule ... You may have a typo." `newData.ref(...)` is unsupported entirely, confirmed against InstantDB's own docs; their documented pattern for pinning a field across an update, `newData.creatorId == data.creatorId`, only covers a plain scalar attribute, not a link. The correct mechanism for a link is `request.modifiedFields`, a list of field names actually being changed in the transaction: `!('owner' in request.modifiedFields)` denies the update outright if `owner` is among them, regardless of what value it would be changed to, rather than trying to compare old and new link values directly.

Deletion of superseded history files and trashed entries is driven entirely by the client (see docs/architecture.md, Maintenance), since only the client can decrypt `createdAt`/`deletedAt` to decide what is old enough to remove. Permission rules allow it because it is still the owning user doing the deleting, not a privileged bypass.

## Uniqueness

"One `keyStore` row per user" is enforced client side only, not at the schema level. A genuine `has: 'one'`/`has: 'one'` link was tried, matching the design intent, but it produced a persistent "already exists" uniqueness rejection on `owner` even after confirming zero existing `keyStore` rows, no leftover entities from diagnostic renames, and correct auth settling to the right user. Deleting and recreating the link fresh (rather than editing cardinality in place) did not resolve it either. Backend enforcement was backed off to `has: 'many'` on the `$users` side; `ensureKeyStore` in `src/db.ts` still queries its own row and treats finding more than one as a fatal error rather than silently picking one, which gives the same practical guarantee without the stuck constraint.

Along the way, one real, separate bug was found and fixed regardless of whether it was the actual cause: `db.getAuth()` does not read InstantDB's in-memory auth state directly, it reads back through `_getCurrentUser` from a persisted key-value store (`this.kv.waitForKeyToLoad`). There is a genuine window right after `signInWithIdToken()` resolves where `getAuth()` can return nothing yet. `signIn()` in `src/db.ts` now waits for `db.getAuth()` to return something before trusting it elsewhere. It only warns, does not throw, on an `email` mismatch against the Firebase credential just used, since `email` is optional on `$users` and may not be reliably populated even on a correct session; an earlier version of this check treated a mismatch as fatal and produced a false failure on a session that was actually fine.

`instant.schema.ts` is now treated as a mirror of `npx instant-cli@latest pull schema`'s output rather than hand-maintained from this document, after the hand-maintained version drifting from what was actually live caused several of the bugs described above (a missing `$users` declaration, a reverse label mismatch, an outright empty `links: {}` reintroduced by a revert). It includes `$files`, no longer just a schema internal now that history lives there (see Entities above), and the `$usersLinkedPrimaryUser` system link, an InstantDB internal this app never touches directly, kept only because the query validator needs local schema for anything a dot notation `where` filter traverses into.

**Confirmed root cause**: `db.queryOnce()`'s result is wrapped in a `data` key, e.g. `{ data: { $users: [...] } }`, not the bare query shape `{ $users: [...] }`. Every `queryOnce` call site in `src/db.ts` read the unwrapped shape (`response.$users` instead of `response.data.$users`), so every one of them always saw `undefined` and fell back to an empty array, regardless of what query shape was tried or what actually existed on the backend. This is why `ensureKeyStore` always concluded zero `keyStore` rows existed and created a new one on every login, no matter which of the three query strategies described above was used, since the bug was in reading the response, not in the query itself. Confirmed via diagnostic logging of the raw response before this fix; typing these calls against the schema (see docs/tech_stack.md, Types) makes this exact class of bug a compile-time error going forward, not just a caught-in-review one.

All six `queryOnce` call sites in `src/db.ts` (`ensureKeyStore`, `fetchUserEntries`, `deleteUserEntry`, `restoreDeletedUserEntry`, `restoreVersionByCommitHash`, `rotateUserMasterKey`) now read `.data.<key>` instead of `.<key>` directly. This affected every one of them, not just the `keyStore` lookup: `fetchUserEntries` would have always seen zero entries too, meaning the vault would have appeared empty on every load even with real entries present, had this gone unnoticed any further.

The app still treats finding more than one `keyStore` row for the current user as a fatal, user visible error rather than silently picking one, as defense in depth: the schema constraint should make this unreachable going forward, but it doesn't retroactively fix rows created before the constraint was tightened, and a bug in enforcement should fail loudly rather than silently corrupt vault access.

## Multi user, no sharing

Every row (`keyStore`, `entries`) has exactly one `owner` link, and every history `$files` row has exactly one `entry` link plus a path namespaced under its owner's `auth.id` — two independent scoping mechanisms, not one. No other link type exists that could grant a second user access. There is no `sharedWith` link, no organization or team entity, no public entries. Access is strictly one owner per row, enforced by the permission rules above.
