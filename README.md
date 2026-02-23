# SecBits

A self-hosted, end-to-end encrypted password manager. All data is encrypted on the client before it reaches Firebase. See [Design Docs](design.md) for architecture, cryptography, features, and security notes.

## Table of Contents

1. [Firebase Setup](#firebase-setup)
2. [Config File Format](#config-file-format)
3. [Building and Deploying](#building-and-deploying)
4. [Usage Guide](#usage-guide)
5. [Testing](#testing)

## Firebase Setup

### 1. Create a Firebase project

1. Go to [console.firebase.google.com](https://console.firebase.google.com) and create a new project.
2. Enable **Firestore Database** (choose a region; **Native mode**).
3. Enable **Email/Password Authentication**: Authentication > Sign-in method > Email/Password > Enable.

### 2. Register a web app

In Project Settings > General > Your apps > Add app (Web). Copy the `firebaseConfig` object. You will need these values.

### 3. Set Firestore security rules

The repository includes `firestore.rules` with the production-ready rules for this app. Copy its contents into **Firestore > Rules** in the Firebase Console and publish.

The rules restrict every path to the authenticated owner (matched by Firebase Auth UID). For the user profile document they enforce that only the expected fields (`username`, `user_master_key`) can be written on create. For password entry documents they require exactly the two encrypted fields (`entry_key`, `value`) plus a 999,999-byte size cap, with a narrow exception for the internal init placeholder document.

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

> **Note:** `databaseURL` is required by the Firebase SDK even if you are not using Realtime Database. If your project config does not include it, set it to `"https://your-project-default-rtdb.firebaseio.com"` as a placeholder.

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
4. The session is held in memory for the lifetime of the page. You will not be asked to upload the config again unless you hard-reload (F5) or log out.

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
| Notes | Free-text notes, hidden by default, reveals for 15 seconds; auto-hidden again when switching to edit mode |
| Tags | Comma-separated; case-insensitive; autocomplete from existing tags |

### Field limits

Every field has a hard character limit enforced in the UI. The limits exist because each entry stores up to 10 commits (version history) in a single Firestore `value` field. That field must stay under **999,999 bytes** after Brotli compression and Ascon-Keccak-512 encryption. Keeping individual fields bounded ensures the combined payload of all commits fits comfortably within that ceiling.

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
| Commits per entry | 10 | Oldest commit is dropped when the chain exceeds this length |

The UI enforces every limit via `maxLength` on inputs, disabled **Add** buttons when the collection cap is reached, and inline error messages. The Save button is disabled whenever any limit is exceeded.

Implementation note: `src/limits.js` defines UI field/collection limits, while the commit-chain cap (`10`) is enforced in `src/firebase.js` where history read/write/truncation happens.

### Copying values

Every sensitive field (password, TOTP code, custom field value) has a copy button. A checkmark appears for 1.5 seconds as visual confirmation. The clipboard is automatically overwritten with an empty string 30 seconds after any copy.

### TOTP codes

If a TOTP secret is valid base32, a live 6-digit code with a countdown circle is shown next to the secret in view mode. Invalid secrets are flagged inline.

### Version history

Each save appends a new commit to the entry's history (up to 10). Saving without any content change is a no-op, so duplicate commits are not created.

Use the **N versions** button in the detail action bar to open the history modal.

- Desktop: two-pane diff modal (commit list on the left, field-level diff on the right)
- Mobile: progressive flow (commit list first, then selected commit diff)

Each commit row shows:

- A 12-character content hash (e.g. `a1b2c3d4e5f6`)
- A **HEAD** badge on the latest commit
- Changed-field badges (`password`, `notes`, `customFields`, etc.)
- Save timestamp

Selecting any commit opens a diff against its parent commit. Notes use line-based diffing with context, scalar fields show remove/add pairs, and array fields show added/removed items.

To non-destructively roll back, select an older commit and click **Restore this version**. This writes a new HEAD commit with the restored snapshot; prior history remains intact.

### Password generator

In edit mode, click **Generate Password** below the password field to open the generator. Adjust character sets and length, then click the check button to apply the generated password.

### Tags and search

Select a tag in the left sidebar to filter entries. Use the search bar to search across title, username, and URLs. Tag suggestions appear as you type in the tags field.

### Settings

Click the gear icon at the bottom of the tag sidebar to open Settings.

- **Export:** downloads a decrypted JSON file (`secbits-export-YYYY-MM-DD.json`) containing all entries, the decrypted user master key, and per-entry doc keys. Keep this file secure.
- **About:** shows the total number of entries and their combined encrypted storage size.

Export JSON includes `user_id`, `username`, `user_master_key_b64`, and decrypted `data`. Each exported entry in `data` includes `entry_key_b64` (the decrypted per-entry doc key) and `value`. Export JSON does **not** include `stored_user_master_key_blob_b64`.

### Logging out

Click the logout button (arrow icon) at the bottom of the tag sidebar. The in-memory session key is cleared immediately.

## Testing

### How to run tests

Run the full test suite:

```bash
npx vitest run
```

Run a specific test file:

```bash
npx vitest run src/tests/crypto.test.js
npx vitest run src/tests/crypto-root-key.test.js
npx vitest run src/tests/crypto-master-key.test.js
npx vitest run src/tests/crypto-entry-key.test.js
npx vitest run src/tests/crypto-entry-history.test.js
npx vitest run src/tests/totp.test.js
npx vitest run src/tests/leancrypto.test.js
```

Optional watch mode while developing:

```bash
npx vitest
```

Run the standalone load test (not Vitest):

```bash
node perf.test.js secbits-config.json
```

### What is covered

| Area | File | Tests | What is validated |
|---|---|---|---|
| `encryptBytesToBlob` / `decryptBlobBytes` / `bytesToB64` | `src/tests/crypto.test.js` | 5 | Round-trip correctness, AEAD tag structure, tamper rejection; base64 helper round-trip |
| `decodeRootMasterKey` | `src/tests/crypto-root-key.test.js` | 4 | Accepts keys ≥256 decoded bytes; rejects short keys and invalid base64 |
| `setupUserMasterKey` / `verifyUserMasterKey` | `src/tests/crypto-master-key.test.js` | 4 | 192-byte blob output; round-trip UMK recovery; wrong-key rejection; invalid-blob rejection |
| `wrapEntryKey` / `unwrapEntryKey` | `src/tests/crypto-entry-key.test.js` | 4 | Doc-key wrap/unwrap round-trip; blob size; input length guard; tamper rejection |
| `encryptEntryHistoryWithDocKey` / `decryptEntryHistoryWithDocKey` | `src/tests/crypto-entry-history.test.js` | 2 | Compress+encrypt/decrypt+decompress round-trip; tamper detection |
| `generateTOTPForCounter` / `base32Decode` / `generateTOTP` | `src/tests/totp.test.js` | 11 | RFC 6238 SHA-1 known vectors; base32 decode correctness, padding/separator stripping, invalid characters; live-clock 6-digit output |
| leancrypto WASM primitives | `src/tests/leancrypto.test.js` | 1 (suite) | Ascon-Keccak AEAD, HMAC-SHA3-224, SHA3-512, HKDF-SHA256, SPHINCS+ vectors |
| `buildExportData` | `src/tests/export-data.test.js` | 1 | Export shape, correct field inclusion, and exclusion of stored user-master-key blob |
| History storage format / `buildSnapshotDelta` / `applySnapshotDelta` | `src/tests/firebase-history-format.test.js` | 10 | Compact storage round-trip; delta correctness and apply round-trip; single-commit edge case; 10-commit truncation cap |
| User master key lifecycle | `src/tests/firebase-key-lifecycle.test.js` | 2 | In-memory key store/clear and zeroization on replace |
| `isHttpUrl` | `src/tests/validation.test.js` | 3 | Accepts http/https URLs; rejects non-http(s) schemes and malformed values |

See [design/testing.md](design/testing.md) for rationale and a detailed breakdown of how each test suite works.
