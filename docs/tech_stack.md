# Tech Stack

- Frontend: React + Vite
- Hosting: Cloudflare Pages
- Auth: Firebase Authentication client SDK (email/password), exchanged for an InstantDB session
- Database and session: InstantDB — `@instantdb/react` on the client; no admin SDK anywhere, since there is no server side component
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
