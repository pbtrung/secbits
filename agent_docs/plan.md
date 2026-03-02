# Implementation Plan

Six milestones in dependency order. Each milestone is shippable and tested before the next begins. Tests are written alongside the implementation they cover, not after.

## Milestone 1: Crypto Primitives

**Goal.** Every cryptographic building block is implemented, independently tested, and produces known-good output against reference vectors before any higher-level code touches it.

### Deliverables

| File | What it provides |
|------|-----------------|
| `src/lib/zbase32.js` | z-base-32 encode / decode |
| `src/lib/blob.js` | blob build (`magic \|\| version \|\| salt \|\| ciphertext \|\| tag`) and parse |
| `src/lib/brotli.js` | Brotli compress / decompress via brotli-wasm |
| `src/crypto.js` (partial) | `encryptBlob` / `decryptBlob` using leancrypto HKDF + AEAD |

leancrypto WASM bundle is pre-built (see `leancrypto/`). The wrapper in `src/crypto.js` loads the module once and exposes typed helpers. No other file imports leancrypto directly.

### Tests

**`src/tests/leancrypto.test.js`**
- HKDF-SHA3-512: known-answer test (KAT) with fixed IKM, salt, length — output matches pre-computed reference.
- AEAD encrypt then decrypt: plaintext recovered exactly.
- AEAD tamper — ciphertext byte flipped: decryption throws `EBADMSG` (-9).
- AEAD tamper — tag byte flipped: decryption throws.
- AEAD tamper — AD byte flipped: decryption throws.
- Wrong key: decryption with different key throws.
- AEAD empty plaintext: encrypt and decrypt succeed (min blob size only).

**`src/tests/zbase32.test.js`**
- Encode → decode round-trip for random 256-bit input returns original bytes.
- Known vector: fixed 32-byte input produces the expected 52-character z-base-32 string.
- Decode rejects string with non-alphabet character.
- Decode rejects string of wrong length.

**`src/tests/blob.test.js`**
- Build then parse round-trip: all fields recovered identically.
- Magic mismatch (`XY` instead of `SB`): parse throws before touching crypto.
- Blob shorter than 132 bytes: parse throws.
- Version bytes extracted correctly from header.
- AD bytes = `magic || version || salt` = exactly 68 bytes.

**`src/tests/crypto.test.js`** (round-trip only at this milestone)
- `encryptBlob` / `decryptBlob` round-trip with a fresh random key: plaintext recovered.
- Any single-byte modification anywhere in the blob causes `decryptBlob` to throw.

---

## Milestone 2: Key Hierarchy

**Goal.** The three-level key hierarchy — root_master_key → UMK → entry_key → entry data — is implemented end-to-end, with independent tests at each level.

### Deliverables

| File | What it provides |
|------|-----------------|
| `src/crypto.js` (complete) | `decodeRootMasterKey`, `encryptUMK`, `decryptUMK`, `generateEntryKey`, `encryptEntryKey`, `decryptEntryKey`, `encryptEntry`, `decryptEntry` |

`encryptEntry` pipeline: entry JSON → Brotli compress → HKDF(entry_key) + AEAD → blob.
`decryptEntry` pipeline: blob → AEAD decrypt → Brotli decompress → JSON parse.

Entry key is 64 random bytes. It is AEAD-encrypted with the UMK before being sent to the Worker and stored in `entries.entry_key`. UMK is 64 random bytes AEAD-encrypted with the root_master_key.

### Tests

**`src/tests/crypto-root-key.test.js`**
- Valid base64 string of exactly 256 decoded bytes: accepted.
- Valid base64 string of 512 decoded bytes: accepted.
- Base64 that decodes to 255 bytes: rejected.
- Non-base64 string: rejected.
- Empty string: rejected.

**`src/tests/key-hierarchy.test.js`**
- UMK round-trip: `encryptUMK(rawUMK, RMK)` → `decryptUMK(blob, RMK)` returns original bytes.
- Wrong RMK: `decryptUMK(blob, wrongRMK)` throws.
- Entry key round-trip: `encryptEntryKey(rawKey, UMK)` → `decryptEntryKey(blob, UMK)` returns original bytes.
- Wrong UMK: `decryptEntryKey(blob, wrongUMK)` throws.
- Full 3-level round-trip: encrypt entry JSON with entry_key (itself wrapped with UMK, itself wrapped with RMK); peel all three layers; recover original JSON.
- Each encryption of the same input produces a different blob (fresh salt each time).
- Tamper at the entry_key blob level: `decryptEntryKey` throws; `decryptEntry` never called.
- Tamper at the entry data blob level: `decryptEntry` throws.

**`src/tests/crypto.test.js`** (complete)
- Full pipeline round-trip: entry object → `encryptEntry` → `decryptEntry` → deep-equal to original.
- All entry types (`login`, `note`, `card`) round-trip cleanly.
- Commit hash embedded in snapshot: after decrypt, `hash === hex(SHA-256(json)).slice(0,32)`.
- `decryptEntry` with wrong entry_key throws at AEAD tag check.
- Brotli compress/decompress of empty string and 10 kB JSON produce correct round-trips.

**`src/tests/commit-hash.test.js`**
- Same JSON always produces the same hash.
- Different JSON produces a different hash.
- Output is exactly 32 lowercase hex characters.
- SHA-256 of the empty string matches the known reference.

---

## Milestone 3: Worker Backend

**Goal.** The Cloudflare Worker is complete: Firebase token verification, user_id derivation, rqlite client, schema migration, and all 14 API routes with full input validation.

### Deliverables

| File | What it provides |
|------|-----------------|
| `worker/src/firebase.js` | RS256 JWK verification; `verifyFirebaseToken(token)` → `{uid, ...}` |
| `worker/src/rqlite.js` | `query(sql, params)` and `execute(sql, params)` over HTTP Basic Auth |
| `worker/src/index.js` | All 14 routes, `user_id` derivation, ownership enforcement, input validation |
| `worker/migrations/0001_initial.sql` | `key_types`, `users`, `key_store`, `entries`, `entry_history`, indexes |
| `worker/migrations/0002_schema_version.sql` | `schema_version` table; inserts version 1 |
| `worker/scripts/migrate.js` | Migration runner: reads current version, applies pending migrations in order |

`user_id = z-base-32(SHA3-256(firebase_uid))`. The Worker computes this on every authenticated request and uses it as the sole scope key for all queries. No client-supplied identifier is trusted for authorization.

### Tests

**`worker/tests/firebase.test.js`**
- Valid RS256 token with correct audience and unexpired `exp`: accepted, `uid` returned.
- Expired token: rejected with 401.
- Wrong audience (`aud` ≠ `FIREBASE_PROJECT_ID`): rejected with 401.
- Forged signature (token signed with a different private key): rejected with 401.
- Malformed JWT (missing segments): rejected with 401.
- Token with `iat` in the future: rejected with 401.

**`worker/tests/rqlite.test.js`** (mocked HTTP)
- `query` sends `POST /db/query` with correct Basic Auth header.
- `execute` sends `POST /db/execute` with correct Basic Auth header.
- Parameterized query body serialized as `[[sql, param1, param2]]`.
- BLOB parameters sent as base64 strings.
- rqlite error response (`"error"` key in result): `execute` throws.
- Network failure: both functions throw.

**`worker/tests/worker-entries.test.js`** (Miniflare or mocked rqlite)
- `GET /entries`: authenticated user with no entries returns `[]`.
- `GET /entries`: returns all live entries for `user_id`, not other users' entries.
- `POST /entries`: inserts entry row and initial history row; returns 201 with `id` and `created_at`.
- `POST /entries`: duplicate `id` returns 409.
- `PUT /entries/:id`: updates `encrypted_data`, `updated_at`; appends history row; returns 200.
- `PUT /entries/:id` with 20 existing commits: 21st commit deletes oldest before inserting.
- `DELETE /entries/:id`: sets `deleted_at`; entry absent from `GET /entries`; present in `GET /entries/trash`.
- `POST /entries/:id/restore`: clears `deleted_at`; entry returns to `GET /entries`.
- `DELETE /entries/:id/purge`: removes entry row and all history rows; returns 200.
- `GET /entries/:id/history`: returns rows ordered by `created_at` descending.
- Ownership: `PUT`/`DELETE`/`POST restore`/`DELETE purge` on another user's entry returns 404.
- Missing Bearer token on any entry route: 401.
- Invalid z-base-32 `id` in body or path: 400.
- `encrypted_data` shorter than 132 decoded bytes: 400.
- `entry_key` shorter than 196 decoded bytes: 400.

**`worker/tests/worker-keys.test.js`**
- `GET /keys`: returns metadata list for authenticated user; no `encrypted_data` in response.
- `POST /keys`: inserts key row; returns 201.
- `POST /keys` with invalid `type` (not in `key_types`): 400.
- `POST /keys` with `type="peer_public"` and `peer_user_id` equal to own `user_id`: 400.
- `GET /keys/:key_id`: returns full record including `encrypted_data`.
- `GET /keys/:key_id` for another user's key: 404.
- `DELETE /keys/:key_id`: removes row; subsequent `GET` returns 404.
- `GET /users/:user_id/public-key`: returns `{user_id, public_key}` if `own_public` exists.
- `GET /users/:user_id/public-key` for user with no `own_public`: 404.

**`worker/tests/migration.test.js`** (in-process SQLite via better-sqlite3)
- Fresh database: `migrate.js` applies all migrations in order; `schema_version` contains the latest version.
- Re-running `migrate.js` on an already-migrated database: no-op, no error, version unchanged.
- All expected tables and indexes present after migration.
- `key_types` seeded with exactly five rows.
- Partial migration (simulated mid-run failure): re-run resumes from correct point.

---

## Milestone 4: Frontend Core

**Goal.** The app runs end-to-end in the browser: config loading, Firebase sign-in, entry list from rqlite, and create / update / delete / restore / purge operations.

### Deliverables

| File | What it provides |
|------|-----------------|
| `src/validation.js` | Config field validators, URL validator, entry field validators |
| `src/api.js` | Worker API client: all entry and key endpoints with auth header injection |
| `src/App.jsx` | Session state machine: idle → config-loaded → signed-in → vault-loaded |
| `src/components/ConfigLoader.jsx` | Config JSON upload and validation UI |
| `src/components/EntryList.jsx` | Left panel: live entries, click to select |
| `src/components/EntryDetail.jsx` | Middle panel: read-only entry view with type badge |
| `src/components/EntryEditor.jsx` | Edit mode: typed form for login / note / card |

Config is validated before any network call. UMK is decrypted from `key_store` after sign-in and held in JS heap for the session. Entry keys are decrypted on demand and cached in memory.

### Tests

**`src/tests/validation.test.js`** (complete)
- `worker_url`: valid HTTPS URL accepted; HTTP rejected; missing scheme rejected.
- `email`: well-formed accepted; missing `@` rejected.
- `root_master_key`: valid base64 ≥ 256 decoded bytes accepted; short key rejected; non-base64 rejected.
- `firebase_api_key`: non-empty string accepted; empty rejected.
- URL field on entry: `https://` accepted; `javascript:` rejected; empty string accepted (optional).
- Custom field key: non-empty accepted; empty rejected.

**`src/tests/api.test.js`** (mocked `fetch`)
- `getEntries()`: sends `GET /entries` with `Authorization: Bearer <token>`; returns parsed array.
- `createEntry(data)`: sends `POST /entries` with correct body shape; returns `{id, created_at}`.
- `updateEntry(id, data)`: sends `PUT /entries/:id`; returns `{id, updated_at}`.
- `deleteEntry(id)`: sends `DELETE /entries/:id`; returns `{id, deleted_at}`.
- `restoreEntry(id)`: sends `POST /entries/:id/restore`; returns `{id}`.
- `purgeEntry(id)`: sends `DELETE /entries/:id/purge`; returns `{id}`.
- `getHistory(id)`: sends `GET /entries/:id/history`; returns array.
- `getKeys()`: sends `GET /keys`; returns metadata array.
- `addKey(data)`: sends `POST /keys`; returns `{key_id, created_at}`.
- `getKey(keyId)`: sends `GET /keys/:key_id`; returns full record.
- `deleteKey(keyId)`: sends `DELETE /keys/:key_id`.
- Worker 401 response: all functions throw with a recognizable auth error.
- Worker 400 response: all functions throw with a recognizable validation error.

**`src/tests/entry-lifecycle.test.js`** (mocked API)
- Create login entry: `encrypted_data` and `entry_key` present in POST body; history row created.
- Decrypt entry after create: recover original JSON with type `"login"`.
- Update entry: `entry_key` not re-sent; `encrypted_data` updated; new history row appended.
- Decrypt updated entry: recover updated JSON.
- Soft delete: entry absent from live list, present in trash.
- Restore: entry back in live list, `deleted_at` null.
- Purge: entry and all history rows gone.
- `entry_key` is identical across create and update calls (not regenerated on edit).

**`src/tests/export-data.test.js`**
- `buildExportData(liveEntries, trashEntries)` returns object with `data` array and `trash` array.
- Each entry in `data` has all fields; no `deleted_at`.
- Each entry in `trash` has all fields including `deleted_at`.
- Export with empty vault: `{data: [], trash: []}`.

---

## Milestone 5: Advanced Features

**Goal.** TOTP, version history with diff viewer, full-text search, password generator, trash view, and vault JSON export are complete and tested.

### Deliverables

| File | What it provides |
|------|-----------------|
| `src/totp.js` | RFC 6238 TOTP: HMAC-SHA1, 30 s step, 6-digit code, countdown |
| `src/components/HistoryViewer.jsx` | Commit list (newest first), restore-to-commit action |
| `src/components/DiffViewer.jsx` | Field-level diff between any two decrypted snapshots |
| `src/components/SearchBar.jsx` | Full-text search across title and username |
| `src/components/TagSidebar.jsx` | Tag list with filter-by-tag |
| `src/components/PasswordGenerator.jsx` | Configurable generator with copy button |
| `src/components/TrashView.jsx` | Deleted entries panel: restore and permanent-delete actions |

### Tests

**`src/tests/totp.test.js`**
- All six RFC 6238 TOTP reference codes (SHA-1, 30 s, 6-digit) match the spec.
- Counter derived from `Math.floor(Date.now() / 1000 / 30)`.
- Output is always exactly 6 digits (left-padded with zeros if needed).
- Different secrets produce different codes for the same timestamp.
- Adjacent 30-second windows produce different codes.
- Invalid base32 TOTP secret: function throws.

**`src/tests/history.test.js`**
- History list for a fresh entry has exactly 1 commit (the creation snapshot).
- After 20 edits, entry has exactly 20 commits.
- On the 21st edit, the oldest commit is gone and there are still 20 commits.
- Commits are ordered newest-first.
- Decrypting any snapshot with the entry's `entry_key` recovers the entry JSON at that point in time.
- Commit hash inside decrypted snapshot matches `hex(SHA-256(snapshotJson)).slice(0,32)`.
- Restoring from a historical snapshot re-encrypts and calls `PUT /entries/:id`.

**`src/tests/search.test.js`**
- Query matching title substring: entry returned.
- Query matching username substring: entry returned.
- Case-insensitive match: `"github"` matches entry with title `"GitHub"`.
- Query with no matches: returns empty array.
- Empty query string: returns all live entries.
- Tag filter: only entries with that tag returned.
- Combined text + tag filter: intersection applied.
- Trashed entries excluded from all search results.

**`src/tests/commit-hash.test.js`** (extended)
- Two snapshot JSONs that differ by only one character produce different hashes.
- Hash is stable: same input on successive calls returns the same 32-character string.
- Hash embedded in `encrypted_snapshot` survives an encrypt → decrypt round-trip unchanged.

---

## Milestone 6: Key Store, Rotation, Sharing, Deployment

**Goal.** Key store management UI, root master key rotation, UMK rotation, cross-user public key sharing, CF Pages build config, and schema migration deployment script are complete and tested.

### Deliverables

| File | What it provides |
|------|-----------------|
| `src/components/KeyStoreManager.jsx` | List keys by type; add emergency key; generate asymmetric pair |
| `src/components/KeyRotation.jsx` | RMK rotation (re-encrypt UMK only) and UMK rotation (re-encrypt all entry keys) |
| `src/components/SharingPanel.jsx` | Fetch peer's public key by user_id; store as `peer_public` in key_store |
| `worker/scripts/migrate.js` (final) | Idempotent migration runner with schema_version tracking |
| `wrangler.toml` | Worker name, routes, no R2 bindings |
| CF Pages build settings | `npm run build`, output `dist`, `VITE_WORKER_URL` env var |

### Tests

**`src/tests/key-rotation.test.js`**
- RMK rotation: `encryptUMK(rawUMK, newRMK)` produces a different blob; `decryptUMK(newBlob, newRMK)` recovers same raw UMK bytes.
- RMK rotation does not alter any `entry_key` blob or `encrypted_data` blob.
- Old RMK: `decryptUMK(newBlob, oldRMK)` throws immediately.
- UMK rotation: all `entry_key` blobs re-encrypted; same 64-byte raw entry keys recovered with new UMK.
- UMK rotation does not alter any `encrypted_data` or `encrypted_snapshot` blob.
- Old UMK: `decryptEntryKey(reEncryptedBlob, oldUMK)` throws.
- Interrupted UMK rotation (only 5 of 10 entry_keys updated): retry re-encrypts remaining 5; final state consistent.

**`worker/tests/sharing.test.js`**
- `GET /users/:user_id/public-key` for a user who has posted `own_public`: returns 200 with `public_key`.
- `GET /users/:user_id/public-key` for a user with no `own_public`: returns 404.
- `POST /keys` with `type="peer_public"` and valid `peer_user_id`: key stored; retrievable via `GET /keys/:key_id`.
- `POST /keys` with `type="peer_public"` and `peer_user_id` equal to own `user_id`: 400.
- `POST /keys` with `type="peer_public"` and `peer_user_id` of a non-existent user: stored (no existence check enforced at Worker level).

**`worker/tests/migration.test.js`** (extended)
- `0001_initial.sql` creates `key_types`, `users`, `key_store`, `entries`, `entry_history`, all three indexes.
- `key_types` seeded with exactly `umk`, `emergency`, `own_public`, `own_private`, `peer_public`.
- `0002_schema_version.sql` creates `schema_version` and inserts version 1.
- Running migrations twice: idempotent, no duplicate rows, no errors.
- `schema_version` after full migration matches `EXPECTED_SCHEMA_VERSION` constant in Worker.
- Foreign key from `key_store.type` to `key_types.type` enforced: insert with unknown type fails.

**`src/tests/e2e.test.js`** (mocked Worker responses)
- Full session: load config → sign in → fetch entries and keys → create login entry → update it → view history (2 commits) → delete → restore → purge → entry gone.
- TOTP entry: create login entry with TOTP secret → TOTP code generated inline → changes every 30 s.
- Key rotation: sign in → rotate RMK → sign in again with new RMK → all entries still decrypt.
- Export: after creating 3 entries and soft-deleting 1, export contains 2 in `data` and 1 in `trash`.
- Wrong RMK at login: UMK decryption fails; session does not load; error displayed.
- Expired Firebase token mid-session: next API call receives 401; session cleared.
