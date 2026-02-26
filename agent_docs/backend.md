# Backend Architecture

SecBits stores all data in **InstantDB**, accessed directly from the browser via `@instantdb/react`. Authentication uses **Firebase Authentication** (email/password). No custom API server is required.

```
Browser (static host) → InstantDB (client SDK, real-time)
Firebase REST → idToken → db.auth.signInWithIdToken()
```

## Auth Flow

1. App POSTs credentials to the Firebase REST sign-in endpoint and receives an `idToken`.
2. App calls `db.auth.signInWithIdToken({ idToken, clientName: "firebase" })`.
3. InstantDB verifies the RS256 signature against Firebase's public JWKs, then looks up or creates the user by email.
4. All subsequent `db` calls are scoped to the authenticated user via permission rules.
5. Token refresh: when the Firebase token has <5 minutes remaining, re-call `firebaseSignIn` and `signInWithIdToken`.
6. Logout: `db.auth.signOut()`, clear in-memory master key.

**InstantDB dashboard setup (one-time):**
- Auth → add OAuth client → provider: Firebase → enter Firebase Project ID, client name `firebase`.

## Schema

`instant.schema.ts` at project root. Two namespaces, both linked to `$users`:

```ts
profiles: i.entity({
  username:        i.string(),
  user_master_key: i.string(),  // base64-encoded 192-byte encrypted blob
})

entries: i.entity({
  entry_id:  i.string().unique(),  // 42-char random a-zA-Z0-9, app-assigned
  entry_key: i.string(),           // base64-encoded ~192-byte wrapped doc key
  value:     i.string(),           // base64-encoded ciphertext (salt||ct||tag)
})
```

Links:

```ts
profileUser: { forward: { on: "profiles", has: "one",  label: "$user" },
               reverse: { on: "$users",   has: "one",  label: "profile" } }
entryUser:   { forward: { on: "entries",  has: "one",  label: "$user" },
               reverse: { on: "$users",   has: "many", label: "entries" } }
```

All binary fields are stored as base64 strings. InstantDB has no BLOB type.

**Entry IDs:** InstantDB assigns its own internal UUIDs. The application-level `entry_id` (42-char random) is stored as a unique attribute; lookups use `where: { entry_id: id }`.

## Permission Rules

`instant.perms.ts` at project root. Rules are evaluated server-side by InstantDB:

```ts
profiles: { allow: { view/create/update/delete: "auth.id in data.ref('$user.id')" } }
entries:  { allow: { view/create/update/delete: "auth.id in data.ref('$user.id')" } }
```

A user can only read and write records linked to their own `$users` row.

## Data Operations (`src/api.js`)

**Profile:**
```js
// Read
const { data } = db.useQuery({ profiles: {} });

// Write
await db.transact(
  db.tx.profiles[id].update({ username, user_master_key }).link({ $user: userId }),
);
```

**Entries:**
```js
// Fetch all
const { data } = db.useQuery({ entries: {} });

// Create
await db.transact(
  db.tx.entries[db.id()]
    .update({ entry_id: appId, entry_key, value })
    .link({ $user: userId }),
);

// Update (look up internal UUID first via where: { entry_id: appId })
await db.transact(db.tx.entries[internalId].update({ entry_key, value }));

// Delete
await db.transact(db.tx.entries[internalId].delete());

// Replace all — atomic (restore)
await db.transact([
  ...existing.map(e => db.tx.entries[e.id].delete()),
  ...incoming.map(e =>
    db.tx.entries[db.id()]
      .update({ entry_id: e.entry_id, entry_key: e.entry_key, value: e.value })
      .link({ $user: userId }),
  ),
]);
```

`db.transact([...])` is atomic — all deletes and inserts succeed or fail together.

## Init (`src/instantdb.js`)

```js
import { init } from "@instantdb/react";
import schema from "../instant.schema";

export function createDb(appId) {
  return init({ appId, schema });
}
```

Called once after the config file is loaded: `createDb(config.instant_app_id)`.

## Required Config Fields

| Field | Source | Notes |
|---|---|---|
| `instant_app_id` | config file | InstantDB App ID from the dashboard |
| `firebase_api_key` | config file | Used only for the Firebase REST sign-in call |
| Firebase Project ID | InstantDB dashboard | Entered once during OAuth client setup |
