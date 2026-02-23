> Part of [Design Docs](../design.md).

# Tech Stack and Project Structure

## Tech stack

| Layer | Technology |
|---|---|
| UI framework | React 19 |
| Build tool | Vite 6 |
| CSS | Bootstrap 5 |
| Icons | Bootstrap Icons |
| AEAD cipher + KDF | leancrypto WASM (Ascon-Keccak-512, HKDF-SHA3-512) |
| TOTP HMAC | @noble/hashes (HMAC-SHA1) |
| Compression | brotli-wasm |
| Database | Cloudflare D1 (SQLite) |
| Auth | PBKDF2-SHA256 + HS256 JWT (Cloudflare Worker, Web Crypto API) |
| Backend runtime | Cloudflare Workers |

## Project structure

```text
secbits/
├── index.html                        # HTML shell with CSP meta tag
├── vite.config.js                    # Vite + React + WASM plugins; test config
├── package.json
├── design.md                         # Design docs index
├── design/                           # Architecture and design reference
│   ├── features.md
│   ├── crypto.md
│   ├── security.md
│   ├── tech-stack.md
│   ├── testing.md
│   └── d1.md                         # D1 + Workers backend architecture
├── worker/                           # Cloudflare Worker (backend API)
│   ├── wrangler.toml                 # Local config (gitignored)
│   ├── wrangler.toml.example         # Template with placeholder values
│   ├── schema.sql                    # D1 table definitions
│   └── src/
│       ├── index.js                  # HTTP router, CORS, all route handlers
│       ├── auth.js                   # PBKDF2-SHA256 hashing, HS256 JWT sign/verify
│       └── db.js                     # D1 query helpers (users + entries)
├── scripts/
│   └── create-user.mjs               # CLI: hash password and output D1 insert command
├── perf.test.js                      # Standalone Node perf/load script
├── data/
│   └── english-words.txt             # Word pool used by perf.test.js
├── public/
│   └── leancrypto/
│       ├── leancrypto.js             # Emscripten UMD bundle (browser + Node)
│       ├── leancrypto.js.md          # Build notes for the leancrypto WASM bundle
│       └── leancrypto.wasm           # Compiled leancrypto WASM binary
└── src/
    ├── main.jsx                      # Entry point, mounts React root
    ├── App.jsx                       # Root component, state management
    ├── crypto.js                     # All cryptographic operations (leancrypto WASM)
    ├── api.js                        # Worker HTTP client: auth, user profile, entry CRUD
    ├── totp.js                       # TOTP generation (RFC 6238, HMAC-SHA1)
    ├── validation.js                 # URL validation helper
    ├── limits.js                     # UI field and per-entry collection limits
    ├── index.css                     # Global styles
    ├── tests/
    │   ├── crypto.test.js            # encryptBytesToBlob / decryptBlobBytes round-trip and bytesToB64 tests
    │   ├── crypto-root-key.test.js   # decodeRootMasterKey: size and base64 validation
    │   ├── crypto-master-key.test.js # setupUserMasterKey / verifyUserMasterKey round-trip and rejection tests
    │   ├── crypto-entry-key.test.js  # wrapEntryKey / unwrapEntryKey round-trip and rejection tests
    │   ├── crypto-entry-history.test.js # encryptEntryHistoryWithDocKey / decryptEntryHistoryWithDocKey round-trip tests
    │   ├── totp.test.js              # RFC 6238 TOTP vectors; base32Decode correctness; generateTOTP smoke tests
    │   ├── leancrypto.test.js        # WASM primitive tests (Vitest + standalone Node)
    │   ├── leancrypto.sphincs-vectors.js # SPHINCS+ fixture vectors
    │   ├── export-data.test.js       # buildExportData shape and field tests
    │   ├── history-format.test.js          # Compact history format; delta helpers; single-commit and truncation edge cases
    │   ├── key-lifecycle.test.js           # User master key store/clear/replace tests
    │   └── validation.test.js        # URL validation tests
    └── components/
        ├── AppSetup.jsx               # Config upload, Worker auth, key setup
        ├── EntryDetail.jsx           # View and edit a single entry
        ├── EntryList.jsx             # Scrollable list of entries
        ├── TagsSidebar.jsx           # Tag filter sidebar + user controls
        ├── SettingsList.jsx          # Settings navigation
        ├── SettingsPanel.jsx         # Export and About pages
        ├── PasswordGenerator.jsx     # Password generator + strength bar
        ├── HistoryDiffModal.jsx      # Version-history modal and field-level commit diff
        └── ResizeHandle.jsx          # Draggable column divider
```
