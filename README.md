# SecBits

A self-hosted, end-to-end encrypted password manager.

This design is **Firebase Auth -> Cloudflare Worker -> Cloudflare R2** only.
There is **no Turso/libSQL/D1 database** and **no backup subsystem**.

## Architecture

```text
Browser -> Firebase Auth (ID token)
        -> Worker (token verify + R2 read/write API)
        -> R2 object (encrypted user export blob)
```

Data flow for every save:
1. Build export JSON payload.
2. Compress payload.
3. Encrypt compressed bytes.
4. Upload encrypted blob to R2.

Data flow on login:
1. Sign in with Firebase.
2. Worker verifies Firebase ID token.
3. Worker reads encrypted blob from R2.
4. Client decrypts + decompresses + loads entries.

## Setup

### 1. Firebase

In Firebase Console:
1. Create a project.
2. Enable `Authentication -> Sign-in method -> Email/Password`.
3. Create at least one user.
4. Copy `Project ID` and web `API key`.

### 2. Cloudflare Worker + R2

```bash
npm install -g wrangler
wrangler login
```

Create R2 bucket and bind it to the Worker (binding name example: `SECBITS_R2`).

Copy `worker/wrangler.toml.example` to `worker/wrangler.toml` and set Worker name, routes, and R2 binding.

Set Worker secrets:

```bash
cd worker
wrangler secret put FIREBASE_PROJECT_ID
wrangler deploy
```

### 3. Config File

Save as `secbits-config.json` and keep it private.

```json
{
  "username": "<display-name>",
  "worker_url": "https://<worker>.<account>.workers.dev",
  "email": "you@example.com",
  "password": "your-firebase-password",
  "firebase_api_key": "<firebase-web-api-key>",
  "root_master_key": "<base64-encoded key, >=256 bytes decoded>",
  "r2": {
    "bucket_name": "secbits-data",
    "prefix": "users/",
    "file_name": "vault.bin"
  }
}
```

R2 object path is config-driven using:
`bucket-name/prefix/file-name`

## Build and Run

```bash
npm install
npm run dev
npm run build
```

Worker dev:

```bash
cd worker
wrangler dev
```

## Usage

1. Upload config JSON in the app.
2. App signs in through Firebase.
3. App loads encrypted state from R2 through Worker.
4. Save operations overwrite the R2 object with a new encrypted export blob.

## Notes

- Start from scratch for this design.
- No migration path is required.
- Backup feature is removed.

## Documentation

See `agent_docs/` for architecture and implementation details.
