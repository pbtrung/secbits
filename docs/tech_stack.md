# Tech Stack

- Frontend: React + Vite
- Hosting: Cloudflare Pages
- Auth: Firebase Authentication client SDK (email/password), exchanged for an InstantDB session
- Database and session: InstantDB — `@instantdb/react` on the client; no admin SDK anywhere, since there is no server side component
- Backup: SigV4 signed upload directly from the client to Cloudflare R2 and to every configured S3 compatible destination (`s3_config` is an array, one or more providers) via `aws4fetch` (a small, zero dependency SigV4 signer built for exactly this browser direct upload case, chosen over the much heavier Node oriented `@aws-sdk/client-s3`), no server proxy; every destination bucket needs CORS enabled for the app's origin. Local export uses a `Blob` and an anchor `download` link, this is a browser app with no filesystem access, not the File System Access API (narrower browser support)
- CSP: `public/_headers` sets a restrictive `Content-Security-Policy` (`connect-src` limited to Firebase, InstantDB, and R2's fixed domain pattern). R2's origin is fixed enough to hardcode (`*.r2.cloudflarestorage.com`); any other S3 compatible destination's origin is not known at build time, so using a non-R2 `s3_config` entry requires manually adding that endpoint to `connect-src` in `public/_headers`, or the browser blocks the upload.
- Local dev: `vite` dev server for the frontend; points at real Firebase and InstantDB dev projects, there is no local emulator for either

## Project Structure

```text
src/
  App.jsx          root state and session flow
  db.js            InstantDB client init and queries
  crypto.js        per-entry encrypt/decrypt pipeline
  lib/             smaller supporting modules (blob, validation, limits, totp, commitHash, backup, s3, entryUtils)
  components/      UI components
  tests/           Vitest test suites
instant.schema.ts  InstantDB entity and link definitions
instant.perms.ts   InstantDB permission rules
public/_headers    Cloudflare Pages response headers, including CSP
```
