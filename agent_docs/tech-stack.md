# Tech Stack and Project Structure

## Tech Stack

| Layer | Technology | Notes |
|---|---|---|
| UI framework | React 19 | Frontend application |
| Build tool | Vite | Dev/build tooling |
| Auth | Firebase Authentication | Email/password with ID token |
| Backend runtime | Cloudflare Workers | API and auth enforcement |
| Storage | Cloudflare R2 | Encrypted vault object storage |
| Crypto/Compression | Client-side crypto + compression modules | `export JSON -> compress -> encrypt` |
| Testing | Vitest | Unit/integration tests |

## Project Structure

```text
secbits/
├── README.md
├── CLAUDE.md
├── agent_docs/
│   ├── design.md
│   ├── backend.md
│   ├── crypto.md
│   ├── security.md
│   ├── features.md
│   ├── tech-stack.md
│   ├── testing.md
│   └── backup.md
├── worker/
│   └── src/
│       ├── index.js
│       └── firebase.js
└── src/
    ├── App.jsx
    ├── api.js
    ├── crypto.js
    ├── components/
    └── tests/
```

## Explicit Exclusions

- No Turso/libSQL/D1 database in this architecture.
- No backup subsystem.
