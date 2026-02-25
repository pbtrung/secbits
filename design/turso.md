> Part of [Design Docs](../design.md).

# Turso Cloud + Workers Backend Architecture

The backend is a Cloudflare Worker backed by a Turso Cloud (libSQL) database. The Worker is the sole trust boundary between the browser and the database — all authorization is enforced here. The browser never touches Turso directly.

```text
Browser (CF Pages) → Worker (auth + CRUD API) → Turso Cloud (libSQL)
```

Authentication uses **Firebase Authentication** (email/password). The app auth screen reads the local JSON config file, uses its Firebase `email` and `password` to sign in via Firebase REST, and receives a Firebase ID token (RS256 JWT). That token is forwarded as a `Bearer` credential on every Worker request. The Worker verifies it against Firebase's public keys and extracts the Firebase UID (`token.sub`) as the canonical user identity. The Worker never handles passwords or issues tokens of its own.

## Database

Turso Cloud is a fully managed libSQL (SQLite-compatible) platform. The Worker connects to the remote database over HTTP using `@libsql/client/web` — no embedded replica, no local file, no periodic sync. Every query goes directly to the remote Turso endpoint. This is the correct model for a stateless Cloudflare Worker which has no persistent filesystem.

Connection is configured per-request via two Worker secrets:

| Secret | Value |
|--------|-------|
| `TURSO_DATABASE_URL` | `libsql://<db-name>-<org>.turso.io` |
| `TURSO_AUTH_TOKEN` | Database auth token from the Turso dashboard |

```js
import { createClient } from "@libsql/client/web";

const client = createClient({
  url: env.TURSO_DATABASE_URL,
  authToken: env.TURSO_AUTH_TOKEN,
});
```

## Schema

IDs for entries are 42-character random strings over `a-zA-Z0-9` (case-sensitive), generated client-side with `crypto.getRandomValues` before each insert. User rows use an internal integer `user_id` primary key and store Firebase UID separately in `firebase_uid` (unique).

The `value` field is capped at 1,900,000 bytes.

```sql
CREATE TABLE IF NOT EXISTS users (
  user_id         INTEGER PRIMARY KEY AUTOINCREMENT,
  firebase_uid    TEXT NOT NULL UNIQUE,           -- Firebase UID (token.sub)
  username        TEXT NOT NULL DEFAULT '',
  user_master_key BLOB,                           -- 192 bytes; NULL until first login
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS entries (
  id         TEXT PRIMARY KEY,                    -- 42-char random a-zA-Z0-9
  user_id    INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  entry_key  BLOB NOT NULL,                       -- ~192 bytes wrapped key
  value      BLOB NOT NULL CHECK(length(value) < 1900000),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_entries_user_id ON entries(user_id);
```

## Worker API

All routes require a valid Firebase ID token in the `Authorization: Bearer <token>` header. Route-level identity is derived only from `token.sub` (no user id in the URL path).

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/me/profile` | Fetch username + user_master_key |
| `POST` | `/me/profile` | Save user_master_key (first login); auto-creates user row |
| `GET` | `/entries` | List all raw entries for authenticated user |
| `GET` | `/entries/:entryId` | Fetch a single entry owned by authenticated user |
| `POST` | `/entries` | Create entry for authenticated user |
| `PUT` | `/entries/:entryId` | Update entry owned by authenticated user |
| `DELETE` | `/entries/:entryId` | Delete entry owned by authenticated user |
| `POST` | `/entries/replace` | Atomically replace all entries for authenticated user |

Binary fields (`entry_key`, `value`, `user_master_key`) are base64-encoded in JSON over the wire and stored as BLOB in Turso. BLOB columns are returned as `Uint8Array`.

### Rate Limiting

The Worker uses Cloudflare's native `[[ratelimits]]` binding (`RATE_LIMITER`), configured in `wrangler.toml`. No separate resource or KV namespace is required — Cloudflare manages counters per edge location.

- **Limit:** 60 requests per 60 seconds per authenticated Firebase UID
- **Key:** `payload.sub` (Firebase UID), applied after token verification
- **Response on violation:** HTTP 429 `{ "error": "Rate limit exceeded" }`
- **Configuration:** entirely in `wrangler.toml`; counters are eventually consistent across edge nodes

## libSQL Query API

Queries use `client.execute()` for single statements and `client.batch()` for atomic multi-statement operations. Results are returned as a `ResultSet` with a `rows` array; columns are accessed by name using bracket notation (`row["user_id"]`).

**Single statement:**
```js
const rs = await client.execute({ sql: "SELECT ...", args: [value] });
const row = rs.rows[0] ?? null;   // first row or null
const rows = rs.rows;             // all rows
```

**Write (no result needed):**
```js
await client.execute({
  sql: "INSERT INTO users (firebase_uid) VALUES (?) ON CONFLICT(firebase_uid) DO NOTHING",
  args: [firebaseUid],
});
```

**Atomic batch (delete + re-insert):**
```js
await client.batch(
  [
    { sql: "DELETE FROM entries WHERE user_id = ?", args: [userId] },
    { sql: "INSERT INTO entries (id, user_id, entry_key, value) VALUES (?, ?, ?, ?)", args: [...] },
  ],
  "write",  // BEGIN IMMEDIATE — serialized write transaction
);
```

## Auth Design

### Firebase sign-in (app auth screen)

The app auth screen signs in using the Firebase REST API with `email` and `password` from the loaded config JSON:

```
POST https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=<FIREBASE_API_KEY>
{ "email": "...", "password": "...", "returnSecureToken": true }
→ { "idToken": "<RS256 JWT, 1 h>", "refreshToken": "...", "localId": "<UID>" }
```

The `idToken` is stored in memory and sent as `Authorization: Bearer <idToken>` on every Worker request. The `refreshToken` is used to obtain a new `idToken` when the current one nears expiry.

Refresh endpoint:

```
POST https://securetoken.googleapis.com/v1/token?key=<FIREBASE_API_KEY>
{ "grant_type": "refresh_token", "refresh_token": "..." }
→ { "id_token": "...", "refresh_token": "..." }
```

### Firebase ID token verification (Worker)

Firebase ID tokens are RS256 JWTs. The Worker verifies them using Firebase's published public keys without any Google SDK. Verification steps:

1. **Fetch public keys** — GET `https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com`. Response contains JWKs keyed by `kid`. Cache per the `Cache-Control: max-age=...` response header (typically ~1 h); rotate keys on cache miss.

2. **Parse the token** — split on `.`, base64url-decode header and payload (no verification yet).

3. **Validate header fields** — require `header.alg === "RS256"` and non-empty `header.kid`.

4. **Select the key** — look up `header.kid` in the cached JWK set; reject if not found.

5. **Verify the signature** — import the selected JWK as a `CryptoKey` (`SubtleCrypto.importKey`, `RSASSA-PKCS1-v1_5`, `SHA-256`) and verify the JWT signature over the `base64url(header) + "." + base64url(payload)` bytes.

6. **Validate claims** — all of the following must hold (with ±300 s clock skew):
   - `payload.exp > now - 300`
   - `payload.iat <= now + 300`
   - `payload.aud === FIREBASE_PROJECT_ID`
   - `payload.iss === "https://securetoken.google.com/" + FIREBASE_PROJECT_ID`
   - `payload.sub` is a non-empty string

7. **Extract identity** — `payload.sub` is the Firebase UID. Resolve it to internal `users.user_id` via `users.firebase_uid`.

The Worker requires `FIREBASE_PROJECT_ID` set as a secret.

### First-login auto-provisioning

There is no explicit user registration endpoint. Users are created in Firebase via the Firebase Console (**Authentication → Users → Add user**) or the Admin SDK / REST API. The `users` row is created lazily on the first authenticated request:

- Every authenticated route first runs idempotent provisioning:
  `INSERT INTO users (firebase_uid) VALUES (?) ON CONFLICT(firebase_uid) DO NOTHING`.
- Provisioning uses `token.sub` as `firebase_uid`, then resolves internal `user_id` for entry queries.

### Root master key rotation

Rotating the `root_master_key` re-encrypts only the `user_master_key` wrapper stored in the database. The entry layer is completely unaffected.

**Key hierarchy:**

```
root_master_key
  └─ wraps user_master_key  (blob in users.user_master_key, 192 bytes)
            └─ wraps doc_key per entry  (blob in entries.entry_key)
                      └─ encrypts entry history  (blob in entries.value)
```

**Client-side flow:**

1. User opens **Settings → Change Root Master Key** and provides a new key (generated in-UI or pasted; must decode to ≥ 256 bytes).
2. UI displays the new key with a Copy button. User copies it, updates the config JSON, and checks a **"I have saved the new root master key"** confirmation checkbox. The Change button is disabled until the checkbox is checked.
3. User clicks **Change**. App re-wraps the in-memory plaintext `user_master_key` under the new root key:
   - Generate a fresh 64-byte random salt.
   - Derive `encKey || encIv` via `HKDF-SHA3-512(newRootMasterKey, newSalt)` → 128 bytes.
   - Encrypt with Ascon-Keccak AEAD → `newSalt || newCiphertext || newTag` (192-byte blob).
4. Upload the new blob: `POST /me/profile` with `{ user_master_key: base64(newBlob) }`. This is the only Worker write.
5. Replace the in-memory `rootMasterKeyBytes` with the new key.

The confirmation gate enforces save-before-commit: the server write only happens after the user explicitly acknowledges they have the new key. Once the write succeeds the old root master key is invalid.

**What changes, what doesn't:**

| Item | Status |
|---|---|
| `users.user_master_key` blob | Re-encrypted with new root key |
| `entries.entry_key` blobs | Unchanged — wrapped with the same `user_master_key` plaintext |
| `entries.value` blobs | Unchanged — encrypted with per-entry doc keys |

**Failure mode:** if the user bypasses or ignores the confirmation and does not have the new key, recovery is impossible — there is no server-side copy of any plaintext key.

## Config File Format

```json
{
  "username": "Your Name",
  "worker_url": "https://<worker>.<account>.workers.dev",
  "email": "user@example.com",
  "password": "your-firebase-password",
  "firebase_api_key": "<firebase-web-api-key>",
  "root_master_key": "<base64-encoded key, >=256 bytes when decoded>"
}
```

| Field | Required | Description |
|---|---|---|
| `username` | Yes | Display name stored in Turso |
| `worker_url` | Yes | Cloudflare Worker base URL |
| `email` | Yes | Firebase user email |
| `password` | Yes | Firebase user password (used only for Firebase sign-in; never sent to the Worker) |
| `firebase_api_key` | Yes | Firebase Web API key from Project settings |
| `root_master_key` | Yes | Base64-encoded random key, must decode to ≥256 bytes |

## File Layout

```text
worker/
  src/
    index.js        — HTTP router, CORS headers, all route handlers
    firebase.js     — verifyFirebaseToken(token, projectId): key fetch/cache + RS256 verify
    db.js           — libSQL query helpers (users + entries)
  schema.sql        — tables above
  wrangler.toml     — local config (gitignored)
  wrangler.toml.example — template with placeholder values
  package.json      — { "type": "module" }, runtime dep: @libsql/client
```

## Client-Side API (`src/api.js`)

| Function | Transport |
|----------|-----------|
| `initApi(config)` | `POST` Firebase sign-in → stores `idToken` + `refreshToken` in memory |
| `fetchUser()` | `GET /me/profile` |
| `saveUserMasterKey(blob)` | `POST /me/profile` |
| `fetchRawUserDocs()` | `GET /entries` |
| `createUserEntry(entry)` | `POST /entries` |
| `updateUserEntry(entryId, entry)` | `PUT /entries/:entryId` |
| `deleteUserEntry(entryId)` | `DELETE /entries/:entryId` |
| `setUserMasterKey` / `getUserMasterKey` / `clearUserMasterKey` | In-memory only |

`initApi` calls the Firebase sign-in REST endpoint and stores the `idToken` and `refreshToken` in module-level variables. Every subsequent Worker request reads the in-memory `idToken` and sets `Authorization: Bearer <idToken>`. A token refresh helper calls the Firebase token refresh endpoint when the current token has less than 5 minutes remaining (checked before each request using the `exp` claim decoded from the JWT payload without signature verification — the Worker performs actual verification).

Binary fields are base64-encoded over HTTP. Entry IDs are generated client-side with `crypto.getRandomValues` before each `POST`.

## Deployment

```bash
# 1. Create Firebase project
# Firebase Console → Authentication → Sign-in method → enable Email/Password
# Note the Web API key and Project ID from Project settings

# 2. Create a Firebase user
# Firebase Console → Authentication → Users → Add user

# 3. Create Turso database
turso db create <db-name>

# 4. Apply schema
turso db shell <db-name> < worker/schema.sql

# 5. Get database URL and auth token
turso db show <db-name> --url
turso db tokens create <db-name>

# 6. Set Worker secrets
cd worker
wrangler secret put FIREBASE_PROJECT_ID
wrangler secret put TURSO_DATABASE_URL
wrangler secret put TURSO_AUTH_TOKEN

# 7. Deploy Worker
wrangler deploy

# 8. Deploy frontend
cd .. && npm run build && wrangler pages deploy dist --project-name secbits
```
