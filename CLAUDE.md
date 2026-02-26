# SecBits

Self-hosted, end-to-end encrypted password manager.

Stack:
- Frontend: React + Vite
- Auth: Firebase Authentication (email/password, ID token)
- Backend: Cloudflare Worker
- Storage: Cloudflare R2 object storage

## Layout

```text
src/
  App.jsx          root state and session flow
  api.js           Worker client (auth + read/write encrypted object)
  crypto.js        export-json -> compress -> encrypt pipeline
  totp.js          RFC 6238 TOTP
  components/      UI
  tests/           Vitest suites
worker/
  src/index.js     routes, Firebase token verification, R2 read/write
  src/firebase.js  Firebase RS256 token verification
```

## Runtime Flow

- Login:
1. App authenticates with Firebase.
2. App sends Firebase ID token to Worker.
3. Worker verifies token and resolves user identity.
4. Worker reads encrypted object from R2 and returns bytes/metadata.
5. App decrypts and loads vault.

- Save:
1. App builds export JSON.
2. App compresses JSON.
3. App encrypts compressed bytes.
4. App sends encrypted blob to Worker.
5. Worker writes blob to configured R2 path.

## Config Contract

Config JSON is required at app startup.

Key fields:
- `worker_url`
- `email`
- `password`
- `firebase_api_key`
- `root_master_key`
- `vault_id` (stable random string; used as R2 path namespace; auth-provider independent)
- `r2.bucket_name`
- `r2.file_name`

R2 path format: `{vault_id}/{file_name}` — auth-provider independent; `vault_id` is sent in the request body and validated server-side.

## Agent Docs

- `agent_docs/design.md` - architectural decisions
- `agent_docs/backend.md` - Worker API and R2 I/O contract
- `agent_docs/crypto.md` - cipher spec, blob format, pipeline
- `agent_docs/security.md` - threat model and guarantees
- `agent_docs/features.md` - feature surface
- `agent_docs/tech-stack.md` - technologies and project layout
- `agent_docs/testing.md` - testing strategy
