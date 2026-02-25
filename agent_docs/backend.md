# Backend Architecture

The backend is a Cloudflare Worker backed by a D1 (SQLite) database. The Worker is the sole trust boundary between the browser and the database — all authorization is enforced here. The browser never touches D1 directly.

```text
Browser (CF Pages) → Worker (auth + CRUD API) → D1 (SQLite)
```

Authentication uses **Firebase Authentication** (email/password). The app auth screen reads the local JSON config file, signs in via Firebase REST, and receives a Firebase ID token (RS256 JWT). That token is forwarded as a `Bearer` credential on every Worker request. The Worker verifies it against Firebase's public keys and extracts the Firebase UID (`token.sub`) as the canonical user identity.

## D1 Schema

Entry IDs are 42-character random strings over `a-zA-Z0-9`, generated client-side before each insert. D1 maximum row size: **2,000,000 bytes**; the `value` field is capped at 1,900,000 bytes.

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

All routes require a valid Firebase ID token in `Authorization: Bearer <token>`. Identity is derived only from `token.sub`.

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/me/profile` | Fetch username + user_master_key |
| `POST` | `/me/profile` | Save user_master_key; auto-creates user row on first call |
| `GET` | `/entries` | List all raw entries for the authenticated user |
| `GET` | `/entries/:entryId` | Fetch a single entry |
| `POST` | `/entries` | Create entry |
| `PUT` | `/entries/:entryId` | Update entry |
| `DELETE` | `/entries/:entryId` | Delete entry |
| `POST` | `/entries/replace` | Bulk delete + insert (used by restore) |

Binary fields (`entry_key`, `value`, `user_master_key`) are base64-encoded in JSON over the wire and stored as BLOB in D1.

## Rate Limiting

60 requests per 60 seconds per Firebase UID via Cloudflare's `RATE_LIMITER` binding (configured in `wrangler.toml`). Exceeding the limit returns HTTP 429.

## Firebase Auth Flow

**App sign-in:**
```
POST https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=<FIREBASE_API_KEY>
{ "email": "...", "password": "...", "returnSecureToken": true }
→ { "idToken": "<RS256 JWT, 1 h>", "refreshToken": "...", "localId": "<UID>" }
```

The `idToken` is stored in memory and refreshed when <5 minutes remain (`TOKEN_REFRESH_SKEW_SECONDS = 300`).

**Worker token verification steps:**

1. Fetch Google's JWKs from `https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com`; cache per `Cache-Control`.
2. Parse JWT; require `alg === "RS256"` and non-empty `kid`.
3. Look up `kid` in JWK set; reject if missing.
4. Verify RS256 signature via `SubtleCrypto`.
5. Validate claims with ±300 s clock skew: `exp`, `iat`, `aud === FIREBASE_PROJECT_ID`, `iss`, non-empty `sub`.
6. Resolve `token.sub` to `users.user_id` via `firebase_uid`.

**First-login auto-provisioning:** Every authenticated route runs an idempotent `INSERT INTO users (firebase_uid) VALUES (?) ON CONFLICT DO NOTHING` before any query.

Worker requires one secret: `FIREBASE_PROJECT_ID` (set via `wrangler secret put FIREBASE_PROJECT_ID`).

## Worker File Layout

```text
worker/
  src/
    index.js        HTTP router, CORS headers, all route handlers
    firebase.js     verifyFirebaseToken(): key fetch/cache + RS256 verify
    db.js           D1 query helpers (users + entries)
  schema.sql        table definitions
  wrangler.toml     local config (gitignored)
  wrangler.toml.example  template with placeholder values
  package.json      { "type": "module" }, no runtime npm deps
```
