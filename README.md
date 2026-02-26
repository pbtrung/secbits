# SecBits

A self-hosted, end-to-end encrypted password manager. All data is encrypted in the browser before reaching the server. See [`agent_docs/`](agent_docs/) for architecture, cryptography, and design details.

## Backend Setup

The backend is **Firebase Authentication** + **InstantDB**. No custom API server is required.

### 1. Firebase

In [Firebase Console](https://console.firebase.google.com):
1. Create a project.
2. Enable **Authentication → Sign-in method → Email/Password**.
3. Add a user under **Authentication → Users**.
4. Note the **Web API key** and **Project ID** from Project settings.

Optional CLI user creation:
```bash
node scripts/create-firebase-user.mjs --api-key <key> --email you@example.com --password yourpassword
```

### 2. InstantDB

1. Create an app at [instantdb.com](https://www.instantdb.com) — note the **App ID**.
2. In the dashboard: **Auth** → add OAuth client → Firebase → enter Firebase Project ID, client name `firebase`.
3. Push schema and permissions:
   ```bash
   npx instant-cli@latest push schema
   npx instant-cli@latest push perms
   ```

### 3. Root master key

Generate in a browser console or Node:
```js
const b64 = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(256))));
console.log(b64);
```

**Store it safely — it cannot be recovered if lost.**

## Config File

Save as `secbits-config.json`. **Keep this file private.**

```json
{
  "username": "<display name>",
  "email": "you@example.com",
  "password": "your-firebase-password",
  "firebase_api_key": "<firebase-web-api-key>",
  "instant_app_id": "<instant-app-id>",
  "root_master_key": "<base64-encoded key, ≥256 bytes when decoded>",
  "backup": [
    {
      "target": "r2",
      "account_id": "<cloudflare-account-id>",
      "bucket": "secbits-backup",
      "access_key_id": "<r2-access-key-id>",
      "secret_access_key": "<r2-secret-access-key>",
      "prefix": "backups/"
    }
  ]
}
```

| Field | Required | Description |
|---|---|---|
| `username` | Yes | Display name |
| `email` | Yes | Firebase email |
| `password` | Yes | Firebase password |
| `firebase_api_key` | Yes | Firebase Web API key |
| `instant_app_id` | Yes | InstantDB App ID |
| `root_master_key` | Yes | Base64-encoded random key, must decode to ≥256 bytes |
| `backup` | No | Cloud backup targets (R2, S3, GCS). See [agent_docs/backup.md](agent_docs/backup.md). |

## Build and Deploy

Requires Node.js 18+ and npm 9+.

```bash
npm install        # deps
npm run build      # output → dist/
```

**Frontend deployment** (`dist/` is a standard static site):
- **Cloudflare Pages:** `wrangler pages deploy dist --project-name secbits`
- **Netlify / Vercel:** build command `npm run build`, output `dist/`
- **NGINX / Apache:** serve `index.html` for all routes (SPA routing)

**Local dev:**
```bash
npm run dev        # frontend → http://localhost:5173
```

## Usage

### First login

Drag and drop (or click to browse) your config `.json` onto the upload area. The app signs into Firebase, authenticates with InstantDB, and loads your entries. The session is held in memory — a hard reload (F5) or logout clears it.

### Entries

- **Create:** click **+**, fill in fields, click **Save**.
- **Edit:** select an entry, click the edit icon.
- **Fields:** Title, Username, Password, TOTP Secrets, URLs, Custom Fields, Notes, Tags.
- **Limits:** see `src/limits.js` for per-field character limits and per-entry collection caps.

### Version history

Each save appends a commit (up to 20). Use the **N versions** button to open the diff modal. Restore any past version with **Restore this version** — this creates a new HEAD commit; history is never overwritten.

### Settings

- **Security:** rotate the root master key (re-encrypts only the user master key blob; entries are unaffected).
- **Backup** (only when targets are configured): export decrypted JSON, manual backup, auto-backup toggle.
- **Restore:** from a cloud target, a local `.bak` file, or a plain JSON export.
- **About:** storage stats and field coverage.

### Change root master key

1. Open **Settings → Security**.
2. Copy the generated key and update your config JSON and any secure backup.
3. Check the confirmation checkbox, then click **Change**.

The old key stops working immediately after the write. If the new key is not saved first, recovery is impossible.

## Testing

```bash
npx vitest run    # run all suites
npx vitest        # watch mode
```

See [agent_docs/testing.md](agent_docs/testing.md) for coverage matrix and suite breakdown.
