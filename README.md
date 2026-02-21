# SecBits

A self-hosted, end-to-end encrypted password manager. All data is encrypted on the client before it reaches Firebase. The server never sees plaintext secrets.

## Table of Contents

1. [Features](#features)
2. [Cryptographic Design](#cryptographic-design)
3. [Firebase Setup](#firebase-setup)
4. [Config File Format](#config-file-format)
5. [Building and Deploying](#building-and-deploying)
6. [Usage Guide](#usage-guide)
7. [Security Notes](#security-notes)
8. [Tech Stack](#tech-stack)
9. [Testing](#testing)
10. [Project Structure](#project-structure)

## Features

| Feature | Description |
|---|---|
| End-to-end encryption | Ascon-Keccak-512 AEAD; Firebase stores only ciphertext |
| Per-entry document keys | Each entry uses its own randomly generated key |
| Version history | Up to 5 snapshots per entry for auditing and recovery |
| TOTP generation | Live 6-digit codes with countdown timer |
| Password generator | Configurable charset, length 8 to 128, entropy display |
| Custom fields | Arbitrary hidden key/value pairs per entry |
| Tags | Organize entries with comma-separated tags; sidebar filter with counts |
| Full-text search | Searches title, username, and URLs in real time |
| Export | Download a decrypted JSON backup at any time |
| Responsive layout | Three-column resizable desktop view; stacked mobile navigation |
| Session persistence | Config cached in `sessionStorage` for the tab lifetime (cleared on close/logout) |
| Unified startup flow | Auth screen keeps the spinner/status visible through entry preload (no separate post-auth loading screen) |
| Clipboard auto-clear | Clipboard is overwritten 30 seconds after any copy |
| Notes auto-hide | Revealed notes are hidden after 15 seconds or on window blur |

## Cryptographic Design

### Key hierarchy

```
Root Master Key (from config file, >=256 bytes)
    |
    +-- HKDF-SHA3-512 -> encKey (64B) + encIv (64B)
    |
    +-- Ascon-Keccak-512(encKey, encIv, userMasterKey) -> encUserMasterKey + AEAD tag (64B)
    |
    +-- User Master Key (64B, random per user, decrypted at login)
            |
            +-- per-entry doc key (64B, random per entry)
                    |
                    +-- HKDF-SHA3-512 -> encKey (64B) + encIv (64B)
                    +-- JSON -> Brotli compress -> Ascon-Keccak-512 encrypt + AEAD tag
                    +-- stored as Firestore Bytes in value field
```

### Algorithms

| Algorithm | Role | Notes |
|---|---|---|
| Ascon-Keccak-512 AEAD | Authenticated encryption | 512-bit key, 512-bit nonce, 512-bit tag; via leancrypto WASM |
| HKDF-SHA3-512 | Key derivation | Fresh 64-byte salt per encryption; derives 128 bytes (encKey \|\| encIv) |
| Brotli (WASM) | Compression | Applied before encryption |
| TOTP-SHA1 | 2FA code generation | RFC 6238, 30-second window |

### Blob format

Every encrypted value has the same layout:

```
salt (64B) || ciphertext (N B) || AEAD tag (64B)
```

Total overhead per blob: 128 bytes. The master key blob is always 192 bytes (`salt || encUserMasterKey || tag`).

### Master key flow

**First login (new user):**

1. `decodeRootMasterKey()` validates the base64 root master key from the config file (must decode to >=256 bytes).
2. A random 64-byte User Master Key is generated, then AEAD-encrypted using keys derived via HKDF-SHA3-512 from the root master key.
3. The 192-byte blob (`salt || encUserMasterKey || tag`) is written to `users/{userId}/user_master_key` in Firestore.
4. The plaintext User Master Key is kept in memory for the rest of the session.

**Returning user:**

1. The stored 192-byte blob is fetched from Firestore.
2. HKDF-SHA3-512 re-derives encKey and encIv from the root master key and the stored salt.
3. Ascon-Keccak-512 AEAD decryption verifies the tag and recovers the User Master Key. A wrong root master key causes authentication failure here.
4. The User Master Key is kept in memory for the session.

### Entry encryption

Each entry stores an array of up to 5 snapshots (version history). On every save:

```
snapshots[]  ->  JSON.stringify  ->  Brotli compress
    ->  Ascon-Keccak-512 AEAD encrypt (with entry's doc key)
    ->  AEAD tag appended
    ->  stored as Firestore Bytes in value field
```

The entry's doc key is itself AEAD-encrypted using the `userMasterKey` and stored in the `entry_key` field of the same Firestore document.

## Firebase Setup

### 1. Create a Firebase project

1. Go to [console.firebase.google.com](https://console.firebase.google.com) and create a new project.
2. Enable **Firestore Database** (choose a region; **Native mode**).
3. Enable **Email/Password Authentication**: Authentication > Sign-in method > Email/Password > Enable.

### 2. Register a web app

In Project Settings > General > Your apps > Add app (Web). Copy the `firebaseConfig` object. You will need these values.

### 3. Set Firestore security rules

Go to Firestore > Rules and replace the default rules with:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId} {
      allow read, write: if request.auth.uid == userId;
      match /data/{docId} {
        allow read, write, delete: if request.auth.uid == userId;
      }
    }
  }
}
```

This ensures each user can only read and write their own data.

### 4. Create a Firebase Auth user and Firestore document

1. In **Authentication > Users**, click **Add user** and enter the email and password you will use to log in.
2. Copy the **UID** shown for the new user.
3. In **Firestore**, manually create a document at `users/{uid}` (using the UID from step 2) with a string field `username` set to any display name you want.

### 5. Generate a root master key

Run this in a browser console or Node.js to generate a strong random root master key:

```js
const bytes = crypto.getRandomValues(new Uint8Array(256));
const b64 = btoa(String.fromCharCode(...bytes));
console.log(b64);
```

Copy the output. This is your `root_master_key`. **Store it safely.** It cannot be recovered if lost. Treat it like a private key.

## Config File Format

Save the following as a `.json` file (e.g. `secbits-config.json`). **Keep this file private. It contains your root master key and login credentials.**

```json
{
  "db_name": "",
  "email": "user@example.com",
  "password": "your-firebase-auth-password",
  "root_master_key": "<base64-encoded key, >=256 bytes when decoded>",
  "auth": {
    "apiKey": "...",
    "authDomain": "your-project.firebaseapp.com",
    "databaseURL": "https://your-project-default-rtdb.firebaseio.com",
    "projectId": "your-project-id",
    "storageBucket": "your-project.appspot.com",
    "messagingSenderId": "...",
    "appId": "..."
  }
}
```

| Field | Required | Description |
|---|---|---|
| `db_name` | No | Named Firestore database (leave `""` for the default database) |
| `email` | Yes | Email address of your Firebase Auth user |
| `password` | Yes | Password of your Firebase Auth user |
| `root_master_key` | Yes | Base64-encoded random key, must decode to >=256 bytes |
| `auth` | Yes | Firebase web app config object from the Firebase console |

## Building and Deploying

### Prerequisites

Node.js 18 or later and npm 9 or later.

### Install dependencies

```bash
npm install
```

### Development server

```bash
npm run dev
```

Opens at `http://localhost:5173` with hot module replacement.

### Production build

```bash
npm run build
```

Output goes to `dist/`. Preview the production build locally:

```bash
npm run preview
```

### Deploying

The `dist/` directory is a standard static site. Deploy it to any static host.

**Firebase Hosting:**

```bash
npm install -g firebase-tools
firebase login
firebase init hosting   # set public dir to "dist", SPA rewrite to index.html
npm run build
firebase deploy
```

**Netlify / Vercel / Cloudflare Pages:**

Set the build command to `npm run build` and the output directory to `dist`. No server-side rendering is needed.

**NGINX / Apache:**

Copy the contents of `dist/` to your web root. Configure the server to serve `index.html` for all routes (SPA routing).

> The app is fully client-side. There is no backend process to run.

## Usage Guide

### First login

1. Open the app in your browser.
2. Drag and drop (or click to browse) your config `.json` file onto the upload area.
3. The app verifies your master key against Firestore, then loads your entries before leaving the auth screen. On first login a new encryption key pair is generated and stored.
4. The config is cached in `sessionStorage` for the lifetime of the browser tab. You will not be asked to upload it again unless you close the tab or log out.

### Creating an entry

1. Click the **+** button in the entry list panel.
2. Fill in the fields you need. All fields are optional except the title.
3. Click **Save**. The entry is encrypted and synced to Firestore.

If you cancel while there are unsaved edits, you will be asked to confirm before the new entry is discarded.

### Entry fields

| Field | Description |
|---|---|
| Title | Display name for the entry |
| Username | Account login name or email |
| Password | Secret, hidden by default, toggle to reveal |
| TOTP Secrets | Base32-encoded TOTP seeds (format is validated) |
| URLs | One or more URLs linked to the account (validated, open in new tab) |
| Custom Fields | Hidden key/value pairs for API keys, recovery codes, etc. |
| Notes | Free-text notes, hidden by default, reveals for 15 seconds |
| Tags | Comma-separated; case-insensitive; autocomplete from existing tags |

### Field limits

Every field has a hard character limit enforced in the UI. The limits exist because each entry stores up to 5 encrypted snapshots (version history) in a single Firestore `value` field. That field must stay under **999,999 bytes** after Brotli compression and Ascon-Keccak-512 encryption. Keeping individual fields bounded ensures the combined payload of all snapshots fits comfortably within that ceiling.

| Field | Limit | Reason |
|---|---|---|
| Title | 200 chars | Display name; longer values add negligible value |
| Username | 200 chars | Covers email addresses and long login names |
| Password | 1,000 chars | Generous for generated passwords; above typical generator output |
| Notes | 100,000 chars | Largest field; single largest contributor to snapshot size |
| URL (each) | 2,048 chars | De-facto browser/server URL length limit |
| TOTP secret (each) | 256 chars | Base32 seeds are typically 16–64 chars; 256 is generous |
| Custom field label | 100 chars | Field name only |
| Custom field value | 1,000 chars | Covers API keys, recovery codes, and similar secrets |
| Tag (each) | 50 chars | Tag labels are short by convention |
| URLs per entry | 20 | Structural limit to cap total payload size |
| TOTP secrets per entry | 10 | Structural limit |
| Custom fields per entry | 20 | Structural limit |
| Tags per entry | 20 | Structural limit |

The UI enforces every limit via `maxLength` on inputs, disabled **Add** buttons when the collection cap is reached, and inline error messages. The Save button is disabled whenever any limit is exceeded.

### Copying values

Every sensitive field (password, TOTP code, custom field value) has a copy button. The clipboard is automatically cleared 30 seconds after any copy.

### TOTP codes

If a TOTP secret is valid base32, a live 6-digit code with a countdown circle is shown next to the secret in view mode. Invalid secrets are flagged inline.

### Version history

Each save creates a new snapshot (up to 5). Use the **Versions** dropdown in view or edit mode to inspect older snapshots. Loading an older version into the editor requires confirmation.

### Password generator

In edit mode, click **Generate Password** below the password field to open the generator. Adjust character sets and length, then click the check button to apply the generated password.

### Tags and search

Select a tag in the left sidebar to filter entries. Use the search bar to search across title, username, and URLs. Tag suggestions appear as you type in the tags field.

### Export

Go to **Settings > Export**. A JSON file containing all your decrypted entry data is downloaded. Keep this file secure. It contains your plaintext secrets along with the master key.

### Logging out

Click the logout button (arrow icon) at the bottom of the tag sidebar. The `sessionStorage` config is cleared immediately.

## Security Notes

**The master key is everything.** Anyone with your config file and access to your Firestore database can decrypt all your data. Keep the config file off shared machines and out of version control.

**Firebase never sees plaintext.** All encryption and decryption happens in the browser. Firestore only stores ciphertext blobs.

**Per-entry keys.** Each entry is encrypted with its own randomly generated document key. Compromise of one entry's key does not affect others.

**AEAD integrity.** Every encrypted value is authenticated by the Ascon-Keccak-512 AEAD tag. Tampered ciphertext or tag causes decryption to fail before any plaintext is returned.

**No separate MAC step.** Authentication is built into the AEAD cipher; there is no HMAC post-processing step. The tag covers both the ciphertext and the associated key material.

**Email/Password auth.** Firebase Email/Password Authentication is used to satisfy Firestore security rules. Only the pre-created account can sign in.

**Session scope.** The config is stored in `sessionStorage`, which is scoped to the tab and cleared when the tab is closed. It is never written to `localStorage`.

**Content Security Policy.** A CSP header restricts scripts, connections, styles, fonts, and images to known-good origins.

## Tech Stack

| Layer | Technology |
|---|---|
| UI framework | React 19 |
| Build tool | Vite 6 |
| CSS | Bootstrap 5 |
| Icons | Bootstrap Icons |
| AEAD cipher + KDF | leancrypto WASM (Ascon-Keccak-512, HKDF-SHA3-512) |
| TOTP HMAC | @noble/hashes (HMAC-SHA1) |
| Compression | brotli-wasm |
| Database | Firebase Firestore |
| Auth | Firebase Email/Password Auth |

## Testing

The project uses **Vitest** for unit tests.

### How to run tests

Run the full test suite:

```bash
npx vitest run
```

Run a specific test file:

```bash
npx vitest run src/tests/crypto.test.js
npx vitest run src/tests/totp.test.js
npx vitest run src/tests/leancrypto.test.js
```

Optional watch mode while developing:

```bash
npx vitest
```

### What is covered

| Area | File | Tests | What is validated |
|---|---|---|---|
| `encryptBytesToBlob` / `decryptBlobBytes` | `src/tests/crypto.test.js` | 3 | Round-trip correctness, AEAD tag structure, tamper rejection |
| `generateTOTPForCounter` | `src/tests/totp.test.js` | 3 | RFC 6238 SHA-1 known vectors across normal and large counters |
| leancrypto WASM primitives | `src/tests/leancrypto.test.js` | 1 (suite) | Ascon-Keccak AEAD, HMAC-SHA3-224, SHA3-512, HKDF-SHA256, SPHINCS+ vectors |

### Why these tests matter

1. Encryption correctness: secrets must decrypt to the exact original bytes with no loss or mutation.
2. Integrity enforcement: AEAD authentication must reject any tampered blob before returning plaintext.
3. Interoperability: TOTP output must match standard RFC vectors so authenticator codes are reliable.
4. WASM correctness: leancrypto primitives are verified against known test vectors before any application code relies on them.

### How the crypto tests work

1. Generate random `keyBytes` and a random 128-byte plaintext using `crypto.getRandomValues`.
2. Encrypt plaintext to blob `c` with `encryptBytesToBlob` (async).
3. Decrypt blob `c` to `d` with `decryptBlobBytes` (async).
4. Compare plaintext and `d` byte-by-byte.
5. Verify blob length equals `SALT_LEN(64) + plaintext.length + TAG_LEN(64)` and that the tag bytes are non-zero.
6. Tamper one byte of the tag and verify `decryptBlobBytes` rejects the blob.

### How the TOTP tests work

1. Use the RFC 6238 SHA-1 shared secret (`12345678901234567890`, base32-encoded).
2. Call `generateTOTPForCounter(secret, counter)` with fixed counters from RFC vectors.
3. Assert the returned 6-digit code matches the expected values.
4. Include larger counter cases to ensure correct 8-byte big-endian counter handling and dynamic truncation behavior.

### How the leancrypto WASM tests work

The test runner lives in `src/tests/leancrypto.test.js` and can run standalone (`node src/tests/leancrypto.test.js`) or inside Vitest (via a dual-mode wrapper that calls `main()` in `test()` when `globalThis.test` is defined). SPHINCS fixture data is separated into `src/tests/leancrypto.sphincs-vectors.js`. The suite exercises the WASM library directly through its C API:

- **Ascon-Keccak AEAD**: encrypt/decrypt with known vectors; verifies out-of-place and in-place modes, and that tampered ciphertext is rejected with the correct error code.
- **HMAC-SHA3-224**: one-shot MAC against a known vector.
- **SHA3-512**: oneshot and streaming hash against known vectors.
- **HKDF-SHA256**: oneshot and streaming extract+expand against known vectors.
- **SPHINCS+**: key generation, sign, and verify for all six SHAKE parameter sets.

## Project Structure

```
secbits/
├── index.html                   # HTML shell with CSP meta tag
├── vite.config.js               # Vite + React + WASM plugins; test config
├── package.json
├── public/
│   └── leancrypto/
│       ├── leancrypto.js        # Emscripten UMD bundle (browser + Node)
│       ├── leancrypto.wasm      # Compiled leancrypto WASM binary
└── src/
    ├── main.jsx                 # Entry point, mounts React root
    ├── App.jsx                  # Root component, state management
    ├── crypto.js                # All cryptographic operations (leancrypto WASM)
    ├── totp.js                  # TOTP generation (RFC 6238, HMAC-SHA1)
    ├── firebase.js              # Firestore read/write operations
    ├── index.css                # Global styles
    ├── tests/
    │   ├── crypto.test.js       # Encryption/decryption tests
    │   ├── totp.test.js         # RFC 6238 TOTP tests
    │   ├── leancrypto.test.js   # WASM vector tests (Vitest + standalone Node)
    │   └── leancrypto.sphincs-vectors.js # SPHINCS+ fixture vectors for leancrypto tests
    └── components/
        ├── FirebaseSetup.jsx    # Config upload, auth, key verification
        ├── EntryDetail.jsx      # View and edit a single entry
        ├── EntryList.jsx        # Scrollable list of entries
        ├── TagsSidebar.jsx      # Tag filter sidebar + user controls
        ├── SettingsList.jsx     # Settings navigation
        ├── SettingsPanel.jsx    # Export and About pages
        ├── PasswordGenerator.jsx# Password generator + strength bar
        └── ResizeHandle.jsx     # Draggable column divider
```
