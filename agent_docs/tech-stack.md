# Tech Stack and Project Structure

## Stack

| Layer | Technology |
|-------|-----------|
| UI framework | React 19 |
| Build tool | Vite |
| Auth | Firebase Authentication (email/password, RS256 ID token) |
| Backend runtime | Cloudflare Workers |
| Storage | Cloudflare R2 (encrypted vault object) |
| AEAD cipher | Ascon-Keccak-512 via leancrypto WASM |
| Key derivation | HKDF-SHA3-512 via leancrypto WASM |
| Compression | Brotli via brotli-wasm |
| TOTP | RFC 6238, HMAC-SHA1, implemented in `src/totp.js` |
| Testing | Vitest |

ID generation:
- Persisted entry IDs use browser-native `crypto.randomUUID()`.

## Project Structure

```
secbits/
├── README.md
├── CLAUDE.md
├── agent_docs/
│   ├── design.md       architectural decisions
│   ├── backend.md      Worker API and R2 I/O contract
│   ├── crypto.md       cipher spec, blob format, pipeline
│   ├── security.md     threat model and guarantees
│   ├── features.md     feature surface
│   ├── tech-stack.md   this file
│   ├── testing.md      testing strategy
│   └── leancrypto.md   leancrypto WASM build instructions and JS API reference
├── leancrypto/         leancrypto WASM bundle + build files (see agent_docs/leancrypto.md)
│   ├── leancrypto.js   pre-built Emscripten module
│   ├── leancrypto.wasm pre-built WASM binary
│   ├── meson.build     WASM-specific Meson build (patches upstream)
│   ├── wasm-cross.ini  Emscripten cross-compilation config
│   ├── seeded_rng_wasm.c WASM RNG source (patches into leancrypto source tree)
│   └── build-wasm.sh   emcc link script
├── worker/
│   └── src/
│       ├── index.js    routes, auth, rate limiting, R2 read/write
│       └── firebase.js Firebase RS256 JWK verification
└── src/
    ├── App.jsx         root state and session flow
    ├── api.js          Worker client, vault read/write, session state
    ├── crypto.js       HKDF + AEAD encrypt/decrypt
    ├── totp.js         RFC 6238 TOTP
    ├── validation.js   input validation helpers
    ├── components/     UI components
    └── tests/          Vitest test suites
```

## Worker Environment

| Variable | Type | Purpose |
|----------|------|---------|
| `FIREBASE_PROJECT_ID` | Secret | Firebase token audience validation |
| `R2_BUCKET_NAME` | Secret | Validated against client-supplied bucket name |
| `SECBITS_R2` | R2 binding | R2 bucket handle for object reads/writes |
| `RATE_LIMITER` | Rate limit binding | 60 requests / 60 seconds per Firebase UID |
