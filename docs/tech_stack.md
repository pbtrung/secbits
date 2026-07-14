# Tech Stack

- Frontend: React + Vite + TypeScript
- Hosting: Cloudflare Pages
- Auth: Firebase Authentication client SDK (email/password), exchanged for an InstantDB session
- Database and session: InstantDB — `@instantdb/react` on the client; no admin SDK anywhere, since there is no server side component. Entry data and entry history are stored as InstantDB Storage files (`$files`), not database fields (see docs/data_model.md, Entities); `keyStore` and `entries` remain ordinary rows.
- Backup: SigV4 signed upload directly from the client to Cloudflare R2 and to every configured S3 compatible destination (`s3_config` is an array, one or more providers) via `aws4fetch` (a small, zero dependency SigV4 signer built for exactly this browser direct upload case, chosen over the much heavier Node oriented `@aws-sdk/client-s3`), no server proxy; every destination bucket needs CORS enabled for the app's origin. Local export uses a `Blob` and an anchor `download` link, this is a browser app with no filesystem access, not the File System Access API (narrower browser support)
- CSP: `public/_headers` sets a restrictive `Content-Security-Policy` (`connect-src` limited to Firebase, InstantDB, and R2's fixed domain pattern). R2's origin is fixed enough to hardcode (`*.r2.cloudflarestorage.com`); any other S3 compatible destination's origin is not known at build time, so using a non-R2 `s3_config` entry requires manually adding that endpoint to `connect-src` in `public/_headers`, or the browser blocks the upload.
- Local dev: `vite` dev server for the frontend; points at real Firebase and InstantDB dev projects, there is no local emulator for either
- Types: `tsconfig.json` (`strict: true`), checked separately from the build via `npm run typecheck` (`tsc --noEmit`) since Vite/Vitest transpile TypeScript through esbuild without type-checking it. `@instantdb/react`'s schema builder generates types from `instant.schema.ts`, so `db.ts`'s query/transact calls are checked against the live schema shape, not just convention.
- Formatting: Prettier formats the whole repo (TS/JS/JSX/CSS/JSON/Markdown) via `.prettierrc`; `npm run format` to apply, `npm run format:check` to verify.

## Project Structure

```text
src/
  App.tsx          root state and session flow
  db.ts            InstantDB client init and queries
  crypto.ts        per-entry encrypt/decrypt pipeline
  types.ts         shared domain types (Entry, ExportData, ConfigContract, ...)
  lib/             smaller supporting modules (blob, validation, limits, totp, commitHash, backup, s3, entryUtils), all .ts
  components/      UI components (.tsx)
  tests/           Vitest test suites (.test.ts)
instant.schema.ts  InstantDB entity and link definitions
instant.perms.ts   InstantDB permission rules
public/_headers    Cloudflare Pages response headers, including CSP
tsconfig.json      TypeScript compiler options, strict mode
.prettierrc        Prettier formatting rules
```
