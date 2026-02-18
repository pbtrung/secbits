# SecBits

A self-hosted, end-to-end encrypted password manager. All data is encrypted on the client before it reaches Firebase — the server never sees plaintext secrets.

---

## Table of Contents

- [Features](#features)
- [Cryptographic Design](#cryptographic-design)
- [Firebase Setup](#firebase-setup)
- [Config File Format](#config-file-format)
- [Building and Deploying](#building-and-deploying)
- [Usage Guide](#usage-guide)
- [Security Notes](#security-notes)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)

---

## Features

- **End-to-end encryption** — XChaCha20 + HMAC-SHA3-512; Firebase stores only ciphertext
- **Per-entry document keys** — each entry uses its own randomly generated key
- **Version history** — up to 5 snapshots per entry for auditing and recovery
- **TOTP generation** — live 6-digit codes with countdown timer
- **Password generator** — configurable charset, length 8–128, entropy display
- **Custom fields** — arbitrary hidden key/value pairs per entry
- **Tags** — organize entries with comma-separated tags; sidebar filter with counts
- **Full-text search** — searches title, username, and URLs in real time
- **Export** — download a decrypted JSON backup at any time
- **Responsive layout** — three-column resizable desktop view; stacked mobile navigation
- **Session persistence** — config cached in `sessionStorage` for the tab lifetime (cleared on close/logout)
- **Clipboard auto-clear** — clipboard is overwritten 30 seconds after any copy
- **Notes auto-hide** — revealed notes are hidden after 15 seconds or on window blur

---

## Cryptographic Design

### Key hierarchy

```
User Master Key (from config file, ≥128 bytes)
    │
    ├─ HKDF-SHA3-512 → encKey (32B) + encIv (24B) + hmacKey (64B)
    │
    ├─ XChaCha20(encKey, encIv, userMasterKey) → stored in Firestore
    ├─ HMAC-SHA3-512(hmacKey, salt ‖ ciphertext) → integrity tag
    │
    └─ userMasterKey (64B, random, decrypted at login)
            │
            └─ per-entry doc key (64B, random per entry)
                    │
                    ├─ HKDF-SHA3-512 → encKey + encIv + hmacKey
                    ├─ JSON → Brotli compress → XChaCha20 encrypt
                    └─ HMAC-SHA3-512 → integrity tag
```

### Algorithms

| Algorithm | Role | Notes |
|---|---|---|
| XChaCha20 | Stream cipher | 256-bit key, 192-bit nonce |
| HKDF-SHA3-512 | Key derivation | Fresh 64-byte salt per encryption |
| HMAC-SHA3-512 | Authentication | Verified before decryption |
| Brotli (WASM) | Compression | Applied before encryption |
| TOTP-SHA1 | 2FA code generation | RFC 6238, 30-second window |

### Master key flow

**First login (new user):**
1. `decodeMasterKey()` validates the base64 key from the config file (must decode to ≥128 bytes).
2. A random 64-byte `userMasterKey` is generated and encrypted with HKDF+XChaCha20+HMAC using the master key.
3. The 192-byte blob (`salt ‖ encryptedKey ‖ mac`) is written to `users/{userId}/master_key` in Firestore.
4. The in-memory `userMasterKey` is used for the rest of the session.

**Returning user:**
1. The stored blob is fetched from Firestore.
2. HMAC is verified (timing-safe comparison) against the derived key — wrong master key fails here.
3. `userMasterKey` is decrypted and used for the session.

### Entry encryption

Each entry stores an array of up to 5 snapshots (version history). On every save:

```
snapshots[]  →  JSON.stringify  →  Brotli compress
    →  XChaCha20 encrypt (with entry's doc key)
    →  HMAC tag appended
    →  stored as Firestore Bytes in value field
```

The entry's doc key is itself wrapped (encrypted + MAC'd) using the `userMasterKey` and stored in the `enc_key` field of the same Firestore document.

---

## Firebase Setup

### 1. Create a Firebase project

1. Go to [console.firebase.google.com](https://console.firebase.google.com) and create a new project.
2. Enable **Firestore Database** (choose a region; **Native mode**).
3. Enable **Anonymous Authentication**: Authentication → Sign-in method → Anonymous → Enable.

### 2. Register a web app

In Project Settings → General → Your apps → Add app (Web). Copy the `firebaseConfig` object — you will need these values.

### 3. Set Firestore security rules

Go to Firestore → Rules and replace the default rules with:

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

### 4. Create your user document

In Firestore, manually create a document at `users/{your-chosen-user-id}` with a string field `username` set to any display name you want.

> **Note:** The `user_id` in your config file must match this document ID exactly.

### 5. Generate a master key

Run this in a browser console or Node.js to generate a strong random master key:

```js
const bytes = crypto.getRandomValues(new Uint8Array(192));
const b64 = btoa(String.fromCharCode(...bytes));
console.log(b64);
```

Copy the output — this is your `master_key`. **Store it safely.** It cannot be recovered if lost. Treat it like a private key.

---

## Config File Format

Save the following as a `.json` file (e.g. `secbits-config.json`). **Keep this file private — it contains your master key.**

```json
{
  "user_id": "your-firestore-user-document-id",
  "db_name": "",
  "master_key": "<base64-encoded key, ≥128 bytes when decoded>",
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
| `user_id` | Yes | ID of your user document in `users/` collection |
| `db_name` | No | Named Firestore database (leave `""` for the default database) |
| `master_key` | Yes | Base64-encoded random key, must decode to ≥128 bytes |
| `auth` | Yes | Firebase web app config object from Firebase console |

---

## Building and Deploying

### Prerequisites

- Node.js 18+
- npm 9+

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

The `dist/` directory is a standard static site. Deploy it to any static host:

**Firebase Hosting:**
```bash
npm install -g firebase-tools
firebase login
firebase init hosting   # set public dir to "dist", SPA rewrite to index.html
npm run build
firebase deploy
```

**Netlify / Vercel / Cloudflare Pages:**
- Build command: `npm run build`
- Output directory: `dist`
- No server-side rendering needed

**NGINX / Apache:**
Copy the contents of `dist/` to your web root. Configure the server to serve `index.html` for all routes (SPA routing).

> The app is fully client-side. There is no backend process to run.

---

## Usage Guide

### First login

1. Open the app in your browser.
2. Drag and drop (or click to browse) your config `.json` file onto the upload area.
3. The app verifies your master key against Firestore and decrypts your data. On first login a new encryption key pair is generated and stored.
4. The config is cached in `sessionStorage` for the lifetime of the browser tab — you will not be asked to upload it again unless you close the tab or log out.

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
| Password | Secret — hidden by default, toggle to reveal |
| TOTP Secrets | Base32-encoded TOTP seeds (validates format on save) |
| URLs | One or more URLs linked to the account (validated, open in new tab) |
| Custom Fields | Hidden key/value pairs for API keys, recovery codes, etc. |
| Notes | Free-text notes — hidden by default, reveals for 15 seconds |
| Tags | Comma-separated; case-insensitive; autocomplete from existing tags |

### Copying values

Every sensitive field (password, TOTP code, custom field value) has a copy button. The clipboard is automatically cleared 30 seconds after any copy.

### TOTP codes

If a TOTP secret is valid base32, a live 6-digit code with a countdown circle is shown next to the secret in view mode. Invalid secrets are flagged inline.

### Version history

Each save creates a new snapshot (up to 5). Use the **Versions** dropdown in view or edit mode to inspect older snapshots. Loading an older version into the editor requires confirmation.

### Password generator

In edit mode, click **Generate Password** below the password field to open the generator. Adjust character sets and length, then click the check button to apply the generated password.

### Tags and search

- Select a tag in the left sidebar to filter entries.
- Use the search bar to search across title, username, and URLs.
- Tag suggestions appear as you type in the tags field.

### Export

Go to **Settings → Export**. A JSON file containing all your decrypted entry data is downloaded. Keep this file secure — it contains your plaintext secrets along with the master key.

### Logging out

Click the logout button (arrow icon) in the bottom of the tag sidebar. The `sessionStorage` config is cleared immediately.

---

## Security Notes

- **The master key is everything.** Anyone with your config file and access to your Firestore database can decrypt all your data. Keep the config file off shared machines and out of version control.
- **Firebase never sees plaintext.** All encryption and decryption happens in the browser. Firestore only stores ciphertext blobs.
- **Per-entry keys.** Each entry is encrypted with its own randomly generated document key. Compromise of one entry's key does not affect others.
- **HMAC integrity.** Every encrypted value is authenticated with HMAC-SHA3-512. Tampered ciphertext is detected before decryption.
- **Timing-safe MAC verification.** The HMAC comparison uses a constant-time function to prevent timing side-channels.
- **Anonymous auth.** Firebase Anonymous Authentication is used to satisfy Firestore security rules — no account creation or password is required.
- **Session scope.** The config is stored in `sessionStorage`, which is scoped to the tab and cleared when the tab is closed. It is never written to `localStorage`.
- **Content Security Policy.** A CSP header restricts scripts, connections, styles, fonts, and images to known-good origins.

---

## Tech Stack

| Layer | Technology |
|---|---|
| UI framework | React 19 |
| Build tool | Vite 6 |
| CSS | Bootstrap 5 |
| Icons | Bootstrap Icons |
| Cipher | @noble/ciphers (XChaCha20) |
| Hash / KDF | @noble/hashes (SHA3, HKDF, HMAC) |
| Compression | brotli-wasm |
| Database | Firebase Firestore |
| Auth | Firebase Anonymous Auth |

---

## Project Structure

```
secbits/
├── index.html                   # HTML shell with CSP meta tag
├── vite.config.js               # Vite + React + WASM plugins
├── package.json
└── src/
    ├── main.jsx                 # Entry point — mounts React root
    ├── App.jsx                  # Root component, state management
    ├── crypto.js                # All cryptographic operations
    ├── firebase.js              # Firestore read/write operations
    ├── index.css                # Global styles
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
