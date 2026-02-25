# Backend Architecture

The backend is a Cloudflare Worker backed by a **Turso Cloud** (libSQL) database. The Worker is the sole trust boundary — all authorization is enforced here. The browser never touches Turso directly.

```text
Browser (CF Pages) → Worker (auth + CRUD API) → Turso Cloud (libSQL)
```

Authentication uses **Firebase Authentication** (email/password). The app signs in via Firebase REST, receives an RS256 ID token, and forwards it as `Authorization: Bearer <token>` on every Worker request. The Worker verifies it against Firebase's public keys and extracts `token.sub` as the canonical user identity.

## Database

Turso Cloud is a managed libSQL (SQLite-compatible) platform. The Worker connects over HTTP using `@libsql/client/web` — no embedded replica, no local file. Every query goes directly to the remote Turso endpoint.

Connection configured per-request via two Worker secrets:

| Secret | Value |
|--------|-------|
| `TURSO_DATABASE_URL` | `libsql://<db-name>-<org>.turso.io` |
| `TURSO_AUTH_TOKEN` | Database auth token from the Turso dashboard |

```js
const client = createClient({
  url: env.TURSO_DATABASE_URL,
  authToken: env.TURSO_AUTH_TOKEN,
});
```

## Schema

Entry IDs are 42-character random strings over `a-zA-Z0-9`, generated client-side. The `value` field is capped at 1,900,000 bytes.

```sql
CREATE TABLE IF NOT EXISTS users (
  user_id         INTEGER PRIMARY KEY AUTOINCREMENT,
  firebase_uid    TEXT NOT NULL UNIQUE,
  username        TEXT NOT NULL DEFAULT '',
  user_master_key BLOB,                          -- 192 bytes; NULL until first login
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS entries (
  id         TEXT PRIMARY KEY,                   -- 42-char random a-zA-Z0-9
  user_id    INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  entry_key  BLOB NOT NULL,                      -- ~192 bytes wrapped doc key
  value      BLOB NOT NULL CHECK(length(value) < 1900000),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_entries_user_id ON entries(user_id);
```

## Worker API

All routes require `Authorization: Bearer <Firebase ID token>`. Identity derived from `token.sub` only.

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/me/profile` | Fetch username + user_master_key |
| `POST` | `/me/profile` | Save user_master_key; auto-creates user row |
| `GET` | `/entries` | List all entries for authenticated user |
| `GET` | `/entries/:entryId` | Fetch single entry |
| `POST` | `/entries` | Create entry |
| `PUT` | `/entries/:entryId` | Update entry |
| `DELETE` | `/entries/:entryId` | Delete entry |
| `POST` | `/entries/replace` | Atomically replace all entries (used by restore) |

Binary fields are base64-encoded in JSON over the wire; stored as BLOB in Turso.

## libSQL Query API

```js
// Single statement
const rs = await client.execute({ sql: 'SELECT ...', args: [value] });
const row = rs.rows[0] ?? null;

// Atomic batch (delete + re-insert for restore)
await client.batch(
  [
    { sql: 'DELETE FROM entries WHERE user_id = ?', args: [userId] },
    { sql: 'INSERT INTO entries ...', args: [...] },
  ],
  'write',  // BEGIN IMMEDIATE — serialized write transaction
);
```

## Rate Limiting

60 requests / 60 seconds per Firebase UID via Cloudflare's `[[ratelimits]]` binding (`RATE_LIMITER`). Configured entirely in `wrangler.toml`; returns HTTP 429 on violation.

## Firebase Auth Flow

**App sign-in:**
```
POST https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=<FIREBASE_API_KEY>
→ { idToken, refreshToken, localId }
```
Token stored in memory; refreshed when <5 minutes remain.

**Worker verification steps:**
1. Fetch Google JWKs; cache per `Cache-Control`.
2. Require `alg === "RS256"`, non-empty `kid`.
3. Verify RS256 signature via `SubtleCrypto`.
4. Validate claims (±300 s skew): `exp`, `iat`, `aud === FIREBASE_PROJECT_ID`, `iss`, non-empty `sub`.
5. Resolve `token.sub` → `users.user_id` via `firebase_uid`.

**First-login provisioning:** every authenticated route runs `INSERT INTO users (firebase_uid) VALUES (?) ON CONFLICT DO NOTHING` before any query.

Worker secrets required: `FIREBASE_PROJECT_ID`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`.

## Worker File Layout

```text
worker/
  src/
    index.js        HTTP router, CORS, rate limiting, all route handlers
    firebase.js     verifyFirebaseToken(): JWK fetch/cache + RS256 verify
    db.js           libSQL query helpers (users + entries)
  schema.sql        table definitions
  wrangler.toml     local config (gitignored)
  wrangler.toml.example  template with placeholder values
  package.json      runtime dep: @libsql/client
```
