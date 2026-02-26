# SecBits

Self-hosted, end-to-end encrypted password manager. The browser handles all cryptography — InstantDB never sees plaintext.

## What

- **Frontend**: React 19 + Vite, Bootstrap 5, leancrypto WASM (Ascon-Keccak-512 AEAD + HKDF-SHA3-512)
- **Backend**: Firebase Authentication (RS256 JWT) + InstantDB (browser SDK, no custom API server)
- **Tests**: Vitest (Node environment)

## Layout

```
src/
  App.jsx          root component; all session state and UI layout live here
  instantdb.js     InstantDB init (db export)
  crypto.js        HKDF key derivation, AEAD encrypt/decrypt, key wrapping
  api.js           InstantDB data operations: profile + entry CRUD
  backup.js        backup/restore/export pipeline, S3-compatible SigV4
  totp.js          RFC 6238 TOTP generation
  limits.js        field and collection size constants
  components/      React UI components
  tests/           Vitest suites
instant.schema.ts  InstantDB namespace + link definitions
instant.perms.ts   InstantDB permission rules
```

## How

```bash
npm install            # install deps
npm run dev            # Vite dev server → http://localhost:5173
npm run build          # production build → dist/
npx vitest run         # run all tests once
npx vitest             # watch mode

npx instant-cli@latest push schema   # push schema to InstantDB
npx instant-cli@latest push perms    # push permission rules
```

## Key Architecture

Key hierarchy — all crypto runs in the browser:

```
Root Master Key (config.json, ≥256 bytes)
  → HKDF-SHA3-512 → User Master Key (64 B, encrypted blob stored in InstantDB profiles)
    → per-entry Doc Key (64 B, wrapped with UMK, stored in InstantDB entries.entry_key)
      → entry value (JSON history → Brotli → Ascon-Keccak-512 AEAD → entries.value)
```

Every encrypted blob has the same layout: `salt (64 B) || ciphertext || AEAD tag (64 B)`.

Session is in-memory only — nothing sensitive is written to `localStorage` or `sessionStorage`.

## Agent Docs

Read these only when the task involves the relevant area:

| File | Read when working on |
|------|----------------------|
| [agent_docs/design.md](agent_docs/design.md) | architecture decisions and rationale (why things are the way they are) |
| [agent_docs/crypto.md](agent_docs/crypto.md) | key hierarchy, AEAD, HKDF, blob format, history encryption, root key rotation |
| [agent_docs/backend.md](agent_docs/backend.md) | InstantDB schema, permission rules, Firebase auth flow, data operations |
| [agent_docs/instantdb.md](agent_docs/instantdb.md) | full InstantDB setup: schema, perms, auth flow, frontend code, config, CSP |
| [agent_docs/backup.md](agent_docs/backup.md) | backup pipeline, R2/S3/GCS targets, restore flow, export format |
| [agent_docs/security.md](agent_docs/security.md) | security properties and guarantees, session scope, CSP |
| [agent_docs/testing.md](agent_docs/testing.md) | test coverage matrix, how each suite works |
| [agent_docs/tech-stack.md](agent_docs/tech-stack.md) | library choices, annotated source tree |
| [agent_docs/features.md](agent_docs/features.md) | full feature list |
