# SecBits

Self-hosted, end-to-end encrypted password manager. The browser handles all cryptography — the Cloudflare Worker is a dumb CRUD API that never sees plaintext.

## What

- **Frontend**: React 19 + Vite, Bootstrap 5, leancrypto WASM (Ascon-Keccak-512 AEAD + HKDF-SHA3-512)
- **Backend**: Cloudflare Worker + D1 (SQLite), Firebase Authentication (RS256 JWT)
- **Tests**: Vitest (Node environment)

## Layout

```
src/
  App.jsx          root component; all session state and UI layout live here
  crypto.js        HKDF key derivation, AEAD encrypt/decrypt, key wrapping
  api.js           Worker HTTP client, entry CRUD, compact history logic
  backup.js        backup/restore/export pipeline, S3-compatible SigV4
  totp.js          RFC 6238 TOTP generation
  limits.js        field and collection size constants
  components/      React UI components
  tests/           Vitest suites
worker/
  src/index.js     HTTP router, CORS, rate limiting, all route handlers
  src/db.js        D1 query helpers
  src/firebase.js  Firebase RS256 token verification
  schema.sql       D1 table definitions
  wrangler.toml.example  config template (wrangler.toml is gitignored)
```

## How

```bash
npm install            # install frontend deps
npm run dev            # Vite dev server → http://localhost:5173
npm run build          # production build → dist/
npx vitest run         # run all tests once
npx vitest             # watch mode

cd worker
wrangler dev           # local Worker → http://localhost:8787
wrangler deploy        # deploy to Cloudflare
```

## Key Architecture

Key hierarchy — all crypto runs in the browser:

```
Root Master Key (config.json, ≥256 bytes)
  → HKDF-SHA3-512 → User Master Key (64 B, encrypted blob stored in D1)
    → per-entry Doc Key (64 B, wrapped with UMK, stored in D1)
      → entry value (JSON history → Brotli → Ascon-Keccak-512 AEAD)
```

Every encrypted blob has the same layout: `salt (64 B) || ciphertext || AEAD tag (64 B)`.

Session is in-memory only — nothing sensitive is written to `localStorage` or `sessionStorage`.

## Agent Docs

Read these only when the task involves the relevant area:

| File | Read when working on |
|------|----------------------|
| [agent_docs/crypto.md](agent_docs/crypto.md) | key hierarchy, AEAD, HKDF, blob format, history encryption, root key rotation |
| [agent_docs/backend.md](agent_docs/backend.md) | Worker routes, D1 schema, Firebase auth, rate limiting |
| [agent_docs/backup.md](agent_docs/backup.md) | backup pipeline, R2/S3/GCS targets, restore flow, export format |
| [agent_docs/security.md](agent_docs/security.md) | threat model, session scope, CSP |
| [agent_docs/testing.md](agent_docs/testing.md) | test coverage matrix, how each suite works |
| [agent_docs/tech-stack.md](agent_docs/tech-stack.md) | library choices, annotated source tree |
| [agent_docs/features.md](agent_docs/features.md) | full feature list |
