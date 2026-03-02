# SecBits

An end-to-end encrypted password manager. All encryption and decryption runs in the browser. The server stores only ciphertext.

## Stack

| Layer | Technology |
|-------|-----------|
| UI framework | React 19 + Vite |
| Hosting | Cloudflare Pages |
| Auth | Firebase Authentication (email/password) |
| Backend | Cloudflare Workers |
| Database | rqlite (SQLite over HTTP) |
| AEAD cipher | Ascon-Keccak-512 via leancrypto WASM |
| Key derivation | HKDF-SHA3-512 via leancrypto WASM |
| Sharing keypair | MLKEM1024+X448 via leancrypto WASM |
| Compression | Brotli via brotli-wasm |
| TOTP | RFC 6238, HMAC-SHA1 |
| Testing | Vitest |

## Architecture

```
Browser (CF Pages) -> Firebase Auth   (ID token)
                   -> CF Worker       (token verify + rqlite API)
                   -> rqlite          (encrypted entry and key rows)
```

Each entry and each key record is independently encrypted. The Worker derives a stable `user_id` from the verified Firebase UID and uses it to scope all database queries. The browser never communicates with rqlite directly and never sees the rqlite credentials.

## Features

- **End-to-end encryption**: plaintext never leaves the browser; ciphertext stored in rqlite.
- **Multi-user**: each Firebase account has an isolated set of entries and keys.
- **Key store**: per-user store for the user master key, emergency access keys, and asymmetric key pairs.
- **Entry sharing**: users can store each other's public keys and use them to encrypt shared entries.
- **Hybrid sharing keys**: `own_public` / `own_private` use leancrypto `mlkem1024+x448` (legacy symbol-compatible with `kyber_1024_x448` in older bundles).
- **Entry types**: Login, Secure Note, Credit Card.
- **TOTP**: live RFC 6238 codes with 30-second countdown.
- **Password generator**: configurable length and character classes.
- **Version history**: per-entry commit history (up to 20), field-level diff viewer.
- **Trash**: soft delete with restore and permanent delete.
- **Search and filter**: full-text search across titles and usernames; tag sidebar.
- **Export**: download decrypted vault as JSON.
- **Key rotation**: rotate the root master key by re-encrypting the UMK blob; entry/history blobs remain unchanged.
- **In-memory session**: keying material lives only in the JS heap; cleared on reload or logout.

## Setup

### 1. Firebase

1. Create a Firebase project.
2. Enable `Authentication -> Sign-in method -> Email/Password`.
3. Create at least one user.
4. Copy the project `Project ID` and the web `API key`.

### 2. rqlite

Deploy a rqlite instance (self-hosted or managed). Note the HTTP endpoint URL, username, and password.

Initialize the schema:

```bash
curl -u "<username>:<password>" \
     -X POST "http://<rqlite-host>/db/execute" \
     -H "Content-Type: application/json" \
     -d '[
  ["CREATE TABLE IF NOT EXISTS key_types (type TEXT PRIMARY KEY)"],
  ["INSERT OR IGNORE INTO key_types (type) VALUES ('umk'), ('emergency'), ('own_public'), ('own_private'), ('peer_public')"],
  ["CREATE TABLE IF NOT EXISTS users (user_id TEXT PRIMARY KEY, created_at TEXT NOT NULL)"],
  ["CREATE TABLE IF NOT EXISTS key_store (key_id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(user_id), type TEXT NOT NULL REFERENCES key_types(type), label TEXT, encrypted_data BLOB, peer_user_id TEXT, created_at TEXT NOT NULL)"],
  ["CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(user_id), entry_key BLOB NOT NULL, encrypted_data BLOB NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT)"],
  ["CREATE TABLE IF NOT EXISTS entry_history (id TEXT PRIMARY KEY, entry_id TEXT NOT NULL REFERENCES entries(id), encrypted_snapshot BLOB NOT NULL, created_at TEXT NOT NULL)"],
  ["CREATE INDEX IF NOT EXISTS idx_key_store_user ON key_store(user_id)"],
  ["CREATE INDEX IF NOT EXISTS idx_entries_user   ON entries(user_id)"],
  ["CREATE INDEX IF NOT EXISTS idx_history_entry  ON entry_history(entry_id)"]
]'
```

### 3. Cloudflare Worker

```bash
npm install -g wrangler
wrangler login
```

Set Worker secrets:

```bash
cd worker
wrangler secret put FIREBASE_PROJECT_ID
wrangler secret put RQLITE_URL
wrangler secret put NGINX_USER
wrangler secret put NGINX_PASSWORD
wrangler deploy
```

`NGINX_USER` and `NGINX_PASSWORD` are the Basic Auth credentials for the nginx proxy in front of the rqlite endpoint.

### 4. Cloudflare Pages

Connect the repository to Cloudflare Pages. Set the build command to `npm run build` and the output directory to `dist`. Add the environment variable `VITE_WORKER_URL` set to the deployed Worker URL.

### 5. Config File

Save as `secbits-config.json` and keep it private — it is the trust anchor for the vault.

```json
{
  "worker_url": "https://<worker>.<account>.workers.dev",
  "email": "you@example.com",
  "password": "your-firebase-password",
  "firebase_api_key": "<firebase-web-api-key>",
  "root_master_key": "<base64-encoded key, >= 256 bytes decoded>"
}
```

The `root_master_key` is the sole secret used to derive all encryption keys. The user identity is derived automatically from the Firebase UID at the Worker.

## Build and Run

```bash
npm install
npm run dev
npm run build
```

Worker dev:

```bash
cd worker
wrangler dev
```

## Usage

1. Upload config JSON in the app.
2. App signs in through Firebase.
3. App fetches encrypted entries and keys from rqlite via the Worker and decrypts them.
4. Creating or updating an entry encrypts it in the browser and writes the ciphertext to rqlite via the Worker.
5. Deleting an entry moves it to Trash. Trash entries can be restored or permanently deleted from the Trash view.

## Documentation

See `agent_docs/` for architecture and implementation details.

## Notes

- `mlkem1024+x448` rollout is a forward-only update in this codebase. No backward-compatible key migration path is implemented.
