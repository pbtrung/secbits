# SecBits

End-to-end encrypted password manager.

Stack:
- Frontend: React + Vite, deployed to Cloudflare Pages
- Auth: Firebase Authentication (email/password, ID token)
- Backend: Cloudflare Worker
- Database: rqlite (SQLite over HTTP, Basic Auth)

## Layout

```text
src/
  App.jsx          root state and session flow
  api.js           Worker client (auth + entry CRUD)
  crypto.js        per-entry encrypt/decrypt pipeline
  totp.js          RFC 6238 TOTP
  validation.js    input validation helpers
  components/      UI components
  tests/           Vitest test suites
worker/
  src/index.js     routes, Firebase token verification, rqlite client
  src/firebase.js  Firebase RS256 JWK verification
  src/rqlite.js    rqlite HTTP API client (Basic Auth)
leancrypto/        pre-built leancrypto WASM bundle
```

## Runtime Flow

Login:
1. App authenticates with Firebase using email and password from config.
2. App sends Firebase ID token to Worker.
3. Worker verifies token and resolves user identity.
4. Worker queries rqlite for all entries scoped to the config vault_id.
5. App decrypts each entry blob and loads the vault.

Save (create or update):
1. App serializes entry to JSON.
2. App Brotli-compresses the JSON bytes.
3. App AEAD-encrypts the compressed bytes with a fresh random salt.
4. App base64-encodes the blob and sends it to the Worker.
5. Worker writes the row to rqlite via HTTP Basic Auth.

## Config Contract

Config JSON is required at app startup. Key fields:
- `worker_url`
- `email`
- `password`
- `firebase_api_key`
- `root_master_key`
- `vault_id` (stable random string; scopes all entries in rqlite)

## Agent Docs

- `agent_docs/design.md` - architectural decisions
- `agent_docs/backend.md` - Worker API, rqlite schema, secrets
- `agent_docs/crypto.md` - cipher spec, blob format, pipeline
- `agent_docs/security.md` - threat model and guarantees
- `agent_docs/features.md` - feature surface
- `agent_docs/tech-stack.md` - technologies and project layout
- `agent_docs/testing.md` - testing strategy
- `agent_docs/leancrypto.md` - leancrypto WASM build and JS API reference
