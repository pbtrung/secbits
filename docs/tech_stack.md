# Tech Stack

- Frontend: React + Vite
- Hosting: Cloudflare Pages
- Auth: Firebase Authentication client SDK (email/password), exchanged for an InstantDB session
- Database and session: InstantDB — `@instantdb/react` on the client; no admin SDK anywhere, since there is no server side component
- Backup: SigV4 signed upload directly from the client to Cloudflare R2 and to a configured S3 compatible endpoint, no server proxy; both destination buckets need CORS enabled for the app's origin. Local export uses a `Blob` and an anchor `download` link, this is a browser app with no filesystem access, not the File System Access API (narrower browser support)
- Local dev: `vite` dev server for the frontend; points at real Firebase and InstantDB dev projects, there is no local emulator for either

## Project Structure

```text
src/
  App.jsx          root state and session flow
  db.js            InstantDB client init and queries
  crypto.js        per-entry encrypt/decrypt pipeline
  components/      UI components
  tests/           Vitest test suites
instant.schema.ts  InstantDB entity and link definitions
instant.perms.ts   InstantDB permission rules
```
