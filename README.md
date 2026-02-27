# SecBits

A self-hosted, end-to-end encrypted password manager.

## Stack

| Layer | Technology |
|-------|-----------|
| UI framework | React 19 + Vite |
| Auth | Firebase Authentication (email/password) |
| Backend | Cloudflare Workers |
| Storage | Cloudflare R2 (encrypted vault object) |
| AEAD cipher | Ascon-Keccak-512 via leancrypto WASM |
| Key derivation | HKDF-SHA3-512 via leancrypto WASM |
| Compression | Brotli via brotli-wasm |
| TOTP | RFC 6238, HMAC-SHA1 |
| Testing | Vitest |

## Architecture

```text
Browser -> Firebase Auth (ID token)
        -> Worker (token verify + R2 read/write API)
        -> R2 object (encrypted vault blob)
```

Data flow for every save:
1. Build export JSON payload.
2. Brotli-compress payload.
3. Derive encryption key and IV from root master key + fresh random salt (HKDF-SHA3-512).
4. AEAD-encrypt compressed bytes (Ascon-Keccak-512).
5. Upload encrypted blob to R2.

Data flow on login:
1. Sign in with Firebase.
2. Worker verifies Firebase ID token.
3. Worker reads encrypted blob from R2.
4. Client decrypts + Brotli-decompresses + loads entries.

Vault payload shape:
- `data`: active entries
- `trash`: deleted entries (soft delete), each with `deletedAt`

Entry identifiers: new persisted entries use `crypto.randomUUID()`.

## Features

- **End-to-end encryption**: plaintext never leaves the browser; ciphertext stored in R2.
- **Entry fields**: title, username, password, notes, URLs, TOTP secrets, custom fields, tags.
- **TOTP**: live RFC 6238 codes with 30-second countdown, multiple secrets per entry.
- **Password generator**: configurable length, character classes.
- **Version history**: per-entry commit history (up to 20), field-level diff viewer.
- **Trash**: soft delete with restore and permanent delete; full commit history preserved.
- **Search and filter**: full-text search across titles and usernames; tag sidebar.
- **Export**: download decrypted vault as JSON.
- **Key rotation**: re-encrypt vault with a new root master key from Settings.
- **Session isolation**: root master key and decrypted data held only in memory; cleared on reload or logout.

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

Create R2 bucket and bind it to the Worker (binding name: `SECBITS_R2`).

Copy `worker/wrangler.toml.example` to `worker/wrangler.toml` and set Worker name, routes, and R2 binding.

Set Worker secrets:

```bash
cd worker
wrangler secret put FIREBASE_PROJECT_ID
wrangler secret put R2_BUCKET_NAME
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
  "vault_id": "<random string, e.g. openssl rand -base64 32>",
  "r2": {
    "bucket_name": "secbits-data",
    "prefix": "vaults",
    "file_name": "vault.bin"
  }
}
```

The R2 object key is `{r2.prefix}/{vault_id}/{file_name}`. Generate `vault_id` once with a CSPRNG and keep it in the config — it determines the storage path independently of the auth provider.

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
3. App loads encrypted vault from R2 through Worker.
4. Save operations overwrite the R2 object with a new encrypted vault blob.
5. Deleting an entry moves it to Trash. Trash entries can be restored or permanently deleted from the Trash view.

## Documentation

See `agent_docs/` for architecture and implementation details.
