# Tech Stack and Project Structure

## Stack

| Layer | Technology |
|-------|-----------|
| UI framework | React 19 |
| Build tool | Vite |
| Hosting | Cloudflare Pages |
| Auth | Firebase Authentication (email/password, RS256 ID token) |
| Backend runtime | Cloudflare Workers |
| Database | rqlite (SQLite over HTTP, Basic Auth) |
| AEAD cipher | Ascon-Keccak-512 via leancrypto WASM |
| Key derivation | HKDF-SHA3-512 via leancrypto WASM |
| Compression | Brotli via brotli-wasm |
| TOTP | RFC 6238, HMAC-SHA1, implemented in `src/totp.js` |
| Testing | Vitest |

ID generation:
- Entry IDs use z-base-32 encoding of random 256-bit values.
- History commit IDs use z-base-32 encoding of random 256-bit values.

## Project Structure

```
secbits/
├── README.md
├── CLAUDE.md
├── agent_docs/
│   ├── design.md         architectural decisions
│   ├── backend.md        Worker API, rqlite schema, secrets
│   ├── crypto.md         cipher spec, blob format, pipeline
│   ├── security.md       threat model and guarantees
│   ├── features.md       feature surface
│   ├── tech-stack.md     this file
│   ├── testing.md        testing strategy
│   └── leancrypto.md     leancrypto WASM build and JS API reference
├── leancrypto/           pre-built leancrypto WASM bundle + build files
│   ├── leancrypto.js     pre-built Emscripten module
│   ├── leancrypto.wasm   pre-built WASM binary
│   ├── meson.build       WASM-specific Meson build
│   ├── wasm-cross.ini    Emscripten cross-compilation config
│   ├── seeded_rng_wasm.c WASM RNG source
│   └── build-wasm.sh     emcc link script
├── worker/
│   └── src/
│       ├── index.js      routes, auth enforcement, rqlite client
│       ├── firebase.js   Firebase RS256 JWK verification
│       └── rqlite.js     rqlite HTTP API client (Basic Auth)
└── src/
    ├── App.jsx           root state and session flow
    ├── api.js            Worker client, entry CRUD, session state
    ├── crypto.js         per-entry HKDF + AEAD encrypt/decrypt
    ├── totp.js           RFC 6238 TOTP
    ├── validation.js     input validation helpers
    ├── components/       UI components
    └── tests/            Vitest test suites
```

## Worker Environment

| Variable | Type | Purpose |
|----------|------|---------|
| `FIREBASE_PROJECT_ID` | Secret | Firebase token audience validation |
| `RQLITE_URL` | Secret | rqlite HTTP API base URL |
| `RQLITE_USERNAME` | Secret | rqlite Basic Auth username |
| `RQLITE_PASSWORD` | Secret | rqlite Basic Auth password |

## Cloudflare Pages Build

| Setting | Value |
|---------|-------|
| Build command | `npm run build` |
| Output directory | `dist` |
| Environment variable | `VITE_WORKER_URL` = deployed Worker URL |
