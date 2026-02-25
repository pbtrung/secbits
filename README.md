# SecBits

A self-hosted, end-to-end encrypted password manager. All data is encrypted on the client before it reaches the server. See [Design Docs](design.md) for architecture, cryptography, features, and security notes.

## Table of Contents

1. [Backend Setup (Worker + D1)](#backend-setup-worker--d1)
2. [Config File Format](#config-file-format)
3. [Building and Deploying](#building-and-deploying)
4. [Usage Guide](#usage-guide)
5. [Testing](#testing)

## Backend Setup (Worker + D1)

The backend is a Cloudflare Worker backed by a D1 (SQLite) database. The Worker handles Firebase token verification and all entry CRUD. The frontend is a static site that talks to the Worker over HTTPS.

### 1. Install Wrangler

```bash
npm install -g wrangler
wrangler login
```

### 2. Create the D1 database

```bash
cd worker
wrangler d1 create <database-name>
```

Copy `worker/wrangler.toml.example` to `worker/wrangler.toml` and fill in `name`, `database_name`, and `database_id` from the command output.

### 3. Apply the schema

```bash
wrangler d1 execute <database-name> --file schema.sql
```

### 4. Create Firebase project + user

```bash
# In Firebase Console:
# 1) Create project
# 2) Enable Authentication -> Sign-in method -> Email/Password
# 3) Create user in Authentication -> Users
```

You need this Firebase value:
- Web API key

Optional CLI helper (instead of Console user creation):

```bash
cd ..
node scripts/create-firebase-user.mjs --api-key <firebase-web-api-key> --email you@example.com --password yourpassword
```

### 5. Set Firebase project ID in Worker secret

```bash
cd worker
wrangler secret put FIREBASE_PROJECT_ID
```

Enter your Firebase Project ID when prompted.

### 6. Configure rate limiting

The `wrangler.toml.example` already includes a `[[ratelimits]]` binding (`RATE_LIMITER`). Copy this section into your `wrangler.toml` as-is — no separate resource to create:

```toml
[[ratelimits]]
name = "RATE_LIMITER"
namespace_id = "1001"

  [ratelimits.simple]
  limit = 60
  period = 60
```

This enforces 60 requests per 60 seconds per authenticated Firebase UID. Exceeding the limit returns HTTP 429.

### 7. Deploy the Worker

```bash
wrangler deploy
```

Note the Worker URL printed — `https://<worker-name>.<account>.workers.dev`. You will need it for the config file.

### 8. Generate a root master key

Run this in a browser console or Node.js:

```js
const bytes = crypto.getRandomValues(new Uint8Array(256));
const b64 = btoa(String.fromCharCode(...bytes));
console.log(b64);
```

This is your `root_master_key`. **Store it safely — it cannot be recovered if lost.** All your encrypted data is derived from it.

## Config File Format

Save the following as a `.json` file (e.g. `secbits-config.json`). **Keep this file private. It contains your root master key and login credentials.**

```json
{
  "username": "<username>",
  "worker_url": "https://<worker>.<account>.workers.dev",
  "email": "you@example.com",
  "password": "your-password",
  "firebase_api_key": "<firebase-web-api-key>",
  "root_master_key": "<base64-encoded key, >=256 bytes when decoded>"
}
```

| Field | Required | Description |
|---|---|---|
| `username` | Yes | Display name stored in D1 |
| `worker_url` | Yes | URL of your deployed Cloudflare Worker |
| `email` | Yes | Firebase email address |
| `password` | Yes | Firebase password |
| `firebase_api_key` | Yes | Firebase Web API key |
| `root_master_key` | Yes | Base64-encoded random key, must decode to ≥256 bytes |

## Building and Deploying

### Prerequisites

Node.js 18 or later and npm 9 or later.

### Install dependencies

```bash
npm install
```

### Local development

Run the Worker locally (from `worker/`):

```bash
cd worker
wrangler d1 execute <database-name> --local --file schema.sql   # first time only
wrangler dev
```

The Worker listens on `http://localhost:8787`. For local dev, temporarily add `http://localhost:8787` to `connect-src` in `index.html`'s CSP, and set `worker_url` in your config file to `http://localhost:8787`.

Run the frontend (from repo root):

```bash
npm run dev
```

Opens at `http://localhost:5173` with hot module replacement.

### Production build

```bash
npm run build
```

Output goes to `dist/`. Preview locally:

```bash
npm run preview
```

### Deploying the Worker

```bash
cd worker
wrangler deploy
```

### Deploying the frontend

The `dist/` directory is a standard static site.

**Cloudflare Pages:**

```bash
npm run build
wrangler pages deploy dist --project-name secbits
```

Or connect the repo to Cloudflare Pages in the dashboard: build command `npm run build`, output directory `dist`.

**Netlify / Vercel:**

Set the build command to `npm run build` and the output directory to `dist`.

**NGINX / Apache:**

Copy `dist/` to your web root. Configure the server to serve `index.html` for all routes (SPA routing).

## Usage Guide

### First login

1. Open the app in your browser.
2. Drag and drop (or click to browse) your config `.json` file onto the upload area.
3. The app authenticates against Firebase, then calls the Worker with Firebase ID token auth. On first login a new user master key is generated and stored in D1.
4. The session is held in memory for the lifetime of the page. You will not be asked to upload the config again unless you hard-reload (F5) or log out.

### Creating an entry

1. Click the **+** button in the entry list panel.
2. Fill in the fields you need. All fields are optional except the title.
3. Click **Save**. The entry is encrypted client-side and sent to the Worker.

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

Every field has a hard character limit enforced in the UI. The limits exist because each entry stores up to 20 commits (version history) in a single D1 `value` column. That column must stay under **1,900,000 bytes** after Brotli compression and Ascon-Keccak-512 encryption. Keeping individual fields bounded ensures the combined payload of all commits fits comfortably within that ceiling.

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
| Commits per entry | 20 | Oldest commit is dropped when the chain exceeds this length |

The UI enforces every limit via `maxLength` on inputs, disabled **Add** buttons when the collection cap is reached, and inline error messages. The Save button is disabled whenever any limit is exceeded.

Implementation note: `src/limits.js` defines UI field/collection limits, while the commit-chain cap (20) is enforced in `src/api.js`.

### Copying values

Every sensitive field (password, TOTP code, custom field value) has a copy button. A checkmark appears for 1.5 seconds as visual confirmation. The clipboard is automatically overwritten with an empty string 30 seconds after any copy.

### TOTP codes

If a TOTP secret is valid base32, a live 6-digit code with a countdown circle is shown next to the secret in view mode. Invalid secrets are flagged inline.

### Version history

Each save appends a new commit to the entry's history (up to 20). Saving without any content change is a no-op, so duplicate commits are not created.

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

- **Backup** (shown only when backup targets are configured in the config file):
  - **Export:** downloads a decrypted JSON file (`secbits-export-YYYY-MM-DD.json`) containing all entries, the decrypted user master key, and per-entry doc keys. Keep this file secure. Export JSON includes `user_id`, `username`, `user_master_key_b64`, and `data`; each entry in `data` includes `entry_key_b64` and `value`.
  - **Backup now:** uploads an encrypted backup to all configured cloud targets immediately.
  - **Auto-backup after save:** when enabled, a backup is triggered automatically after every successful create, update, restore, or delete.
  - **Last backup:** timestamp of the most recent successful upload (resets on page reload).
- **Restore** (always visible):
  - Select a configured cloud target or **Local file** as the source. When no targets are configured only the file picker is shown.
  - Click **Restore** to decrypt and apply the backup. A confirmation dialog shows the entry count and warns that the operation replaces all current entries and cannot be undone.
- **About:** shows entry count, total stored size, field coverage, version history stats, top tags, and the 5 largest entries.

See [design/backup.md](design/backup.md) for full backup and restore details, cloud target configuration, and the encrypted file format.

### Logging out

Click the logout button (arrow icon) at the bottom of the tag sidebar. The in-memory session key and auth token are cleared immediately.

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

See [design/testing.md](design/testing.md) for test coverage matrix, rationale, and detailed breakdown of each suite.
