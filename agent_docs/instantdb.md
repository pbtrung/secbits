# Backend: Firebase Auth + InstantDB

SecBits stores all data in **InstantDB**, accessed directly from the browser via the `@instantdb/react` SDK. Authentication uses **Firebase Authentication** (email/password). No custom API server is required.

```
Browser (static host)
  ├─ leancrypto WASM  — all encryption/decryption
  ├─ @instantdb/react — real-time data access, auth
  └─ Firebase REST    — email/password sign-in
```

---

## Auth Flow

InstantDB has a first-class Firebase OAuth integration. No custom token-exchange endpoint is required.

**One-time setup (InstantDB dashboard):**
1. Create an InstantDB app at [instantdb.com](https://www.instantdb.com).
2. Go to **Auth** → add OAuth client → provider: **Firebase** → enter your Firebase Project ID and a client name (e.g. `firebase`).

**Runtime:**
1. App POSTs credentials to the Firebase REST sign-in endpoint and receives an `idToken`.
2. App calls `db.auth.signInWithIdToken({ idToken, clientName: "firebase" })`.
3. InstantDB verifies the RS256 signature against Firebase's public JWKs, then looks up or creates the user by email.
4. All subsequent `db` calls are scoped to the authenticated user via permission rules.
5. Token refresh: when the Firebase token has <5 minutes remaining, re-call `firebaseSignIn` and `signInWithIdToken`.
6. Logout: `db.auth.signOut()`, clear in-memory master key.

---

## Schema

`instant.schema.ts` (project root):

```ts
import { i } from "@instantdb/react";

const _schema = i.schema({
  entities: {
    profiles: i.entity({
      username:        i.string(),
      user_master_key: i.string(),  // base64-encoded 192-byte encrypted blob
    }),
    entries: i.entity({
      entry_key: i.string(),  // base64-encoded ~192-byte wrapped doc key
      value:     i.string(),  // base64-encoded ciphertext (salt||ct||tag)
    }),
  },
  links: {
    profileUser: {
      forward: { on: "profiles", has: "one",  label: "$user"   },
      reverse: { on: "$users",   has: "one",  label: "profile" },
    },
    entryUser: {
      forward: { on: "entries", has: "one",  label: "$user"   },
      reverse: { on: "$users",  has: "many", label: "entries" },
    },
  },
});

export type Schema = typeof _schema;
export default _schema;
```

All binary fields (`user_master_key`, `entry_key`, `value`) are stored as base64 strings — InstantDB has no BLOB type.

**Entry IDs:** `db.id()` generates a UUID client-side that becomes the record's InstantDB primary key. The app stores and uses this UUID directly — no separate application-level ID attribute is needed.

---

## Permission Rules

`instant.perms.ts` (project root):

```ts
import type { InstantRules } from "@instantdb/react";

const rules = {
  profiles: {
    allow: {
      view:   "auth.id in data.ref('$user.id')",
      create: "auth.id in data.ref('$user.id')",
      update: "auth.id in data.ref('$user.id')",
      delete: "auth.id in data.ref('$user.id')",
    },
  },
  entries: {
    allow: {
      view:   "auth.id in data.ref('$user.id')",
      create: "auth.id in data.ref('$user.id')",
      update: "auth.id in data.ref('$user.id')",
      delete: "auth.id in data.ref('$user.id')",
    },
  },
} satisfies InstantRules;

export default rules;
```

Rules are evaluated server-side by InstantDB. A user can only read and write records linked to their own `$users` row.

---

## Frontend Code

### `src/instantdb.js`

```js
import { init } from "@instantdb/react";
import schema from "../instant.schema";

export function createDb(appId) {
  return init({ appId, schema });
}
```

Called once after the config file is loaded, passing `config.instant_app_id`.

### Auth (`App.jsx`)

```js
import { createDb } from "./instantdb.js";

// After loading config file:
const db = createDb(config.instant_app_id);

// Sign in
const idToken = await firebaseSignIn(email, password, firebaseApiKey);
await db.auth.signInWithIdToken({ idToken, clientName: "firebase" });

// Sign out
await db.auth.signOut();
```

### `src/api.js`

**Profile:**

```js
// Read
const { data } = db.useQuery({ profiles: {} });
const profile = data?.profiles[0] ?? null;

// Write
await db.transact(
  db.tx.profiles[profileInstantId]
    .update({ username, user_master_key })
    .link({ $user: currentUserId }),
);
```

**Entries:**

```js
// Fetch all
const { data } = db.useQuery({ entries: {} });

// Create
const entryId = db.id();
await db.transact(
  db.tx.entries[entryId]
    .update({ entry_key, value })
    .link({ $user: currentUserId }),
);

// Update
await db.transact(db.tx.entries[entryId].update({ entry_key, value }));

// Delete
await db.transact(db.tx.entries[entryId].delete());

// Replace all — atomic (restore)
await db.transact([
  ...existingEntries.map(e => db.tx.entries[e.id].delete()),
  ...newEntries.map(e =>
    db.tx.entries[db.id()]
      .update({ entry_key: e.entry_key, value: e.value })
      .link({ $user: currentUserId }),
  ),
]);
```

`db.transact([...])` is atomic — all deletes and inserts succeed or fail together.

---

## Config File

```json
{
  "username": "<display-name>",
  "email": "you@example.com",
  "password": "your-firebase-password",
  "firebase_api_key": "<firebase-web-api-key>",
  "instant_app_id": "<instant-app-id>",
  "root_master_key": "<base64-encoded key, ≥256 bytes when decoded>",
  "backup": [
    {
      "target": "r2",
      "account_id": "<cloudflare-account-id>",
      "bucket": "secbits-backup",
      "access_key_id": "<r2-access-key-id>",
      "secret_access_key": "<r2-secret-access-key>",
      "prefix": "backups/"
    }
  ]
}
```

`instant_app_id` is the InstantDB App ID from the dashboard. It is read from the config file at runtime.

---

## CSP

```html
<meta http-equiv="Content-Security-Policy" content="
  default-src 'none';
  script-src  'self' 'wasm-unsafe-eval';
  connect-src 'self' https://*.instantdb.com wss://*.instantdb.com;
  style-src   'self' 'unsafe-inline';
  font-src    'self';
  img-src     'self' data:;
">
```

`wss://*.instantdb.com` covers the InstantDB real-time WebSocket connection.

---

## Setup

### 1. Firebase

In [Firebase Console](https://console.firebase.google.com):
1. Create a project.
2. Enable **Authentication → Sign-in method → Email/Password**.
3. Add a user under **Authentication → Users**.
4. Note the **Web API key** and **Project ID** from Project settings.

### 2. InstantDB

1. Create an app at [instantdb.com](https://www.instantdb.com) — note the App ID.
2. **Auth** → add OAuth client → Firebase → enter Firebase Project ID, client name `firebase`.
3. Push schema and permissions:
   ```bash
   npx instant-cli@latest push schema
   npx instant-cli@latest push perms
   ```

### 3. Build and deploy

```bash
npm install @instantdb/react
npm run build
```

Deploy `dist/` to any static host (Cloudflare Pages, Netlify, Vercel, NGINX).

---

## Key Architecture

All crypto runs in the browser — InstantDB never receives plaintext:

```
Root Master Key (config, ≥256 bytes)
  → HKDF-SHA3-512 → User Master Key (64 B, encrypted → profiles.user_master_key)
    → per-entry Doc Key (64 B, wrapped with UMK → entries.entry_key)
      → entry value (JSON history → Brotli → Ascon-Keccak-512 AEAD → entries.value)
```

---

## Constraints

- **Managed only.** InstantDB cannot be self-hosted.
- **Blob size.** Entry `value` fields can reach ~1.9 MB. Verify InstantDB's string attribute size limit before deploying at scale.
- **Rate limiting.** InstantDB enforces its own per-app limits; there is no application-level rate limiting.
