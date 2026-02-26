# Tech Stack and Project Structure

## Tech Stack

| Layer | Technology | Notes |
|---|---|---|
| UI framework | React 19 | Hooks-based, no Redux |
| Build tool | Vite 6 | HMR dev, optimized production builds |
| CSS | Bootstrap 5 | Utility classes + minimal custom CSS |
| Icons | Bootstrap Icons | SVG icon system |
| AEAD cipher + KDF | leancrypto WASM | Ascon-Keccak-512, HKDF-SHA3-512 via Emscripten UMD bundle |
| TOTP HMAC | @noble/hashes | HMAC-SHA1 |
| Compression | brotli-wasm | WASM-based Brotli codec |
| Database | InstantDB | Managed real-time graph DB; browser SDK, no custom API server |
| Auth | Firebase Authentication | Email/password; RS256 ID token, 1-hour expiry |
| Testing | Vitest | Node test environment |

## Project Structure

```text
secbits/
├── CLAUDE.md                         # Project context for Claude Code
├── index.html                        # HTML shell with CSP meta tag
├── vite.config.js                    # Vite + React + WASM plugins; Vitest config
├── package.json
├── instant.schema.ts                 # InstantDB namespace + link definitions
├── instant.perms.ts                  # InstantDB permission rules
├── agent_docs/                       # Detailed reference docs (read on demand)
│   ├── features.md
│   ├── crypto.md
│   ├── security.md
│   ├── tech-stack.md
│   ├── testing.md
│   ├── backup.md
│   ├── backend.md
│   └── instantdb.md
├── scripts/
│   └── create-firebase-user.mjs     # CLI: create a Firebase user via Auth REST API
├── perf.test.js                      # Standalone Node perf/load script
├── data/
│   └── english-words.txt            # Word pool for perf.test.js
├── public/
│   └── leancrypto/
│       ├── leancrypto.js            # Emscripten UMD bundle
│       ├── leancrypto.js.md         # Build notes for the WASM bundle
│       └── leancrypto.wasm          # Compiled WASM binary
└── src/
    ├── main.jsx                     # Entry point, mounts React root
    ├── App.jsx                      # Root component, all session state
    ├── instantdb.js                 # InstantDB init (db export)
    ├── crypto.js                    # All cryptographic operations (leancrypto WASM)
    ├── api.js                       # InstantDB data operations: profile + entry CRUD
    ├── backup.js                    # Backup/restore/export pipeline
    ├── totp.js                      # TOTP generation (RFC 6238, HMAC-SHA1)
    ├── validation.js                # URL validation helper
    ├── limits.js                    # UI field and per-entry collection limits
    ├── index.css                    # Global styles
    ├── tests/
    │   ├── crypto.test.js
    │   ├── crypto-root-key.test.js
    │   ├── crypto-master-key.test.js
    │   ├── crypto-entry-key.test.js
    │   ├── crypto-entry-history.test.js
    │   ├── totp.test.js
    │   ├── leancrypto.test.js
    │   ├── leancrypto.sphincs-vectors.js
    │   ├── export-data.test.js
    │   ├── history-format.test.js
    │   ├── key-lifecycle.test.js
    │   └── validation.test.js
    └── components/
        ├── AppSetup.jsx             # Config upload, Firebase auth, key setup
        ├── EntryDetail.jsx          # View and edit a single entry
        ├── EntryList.jsx            # Scrollable list of entries
        ├── TagsSidebar.jsx          # Tag filter sidebar + user controls
        ├── SettingsList.jsx         # Settings navigation
        ├── SettingsPanel.jsx        # Backup, Restore, Security, About pages
        ├── PasswordGenerator.jsx   # Password generator + strength bar
        ├── HistoryDiffModal.jsx     # Version history modal and field-level diff
        └── ResizeHandle.jsx         # Draggable column divider
```
