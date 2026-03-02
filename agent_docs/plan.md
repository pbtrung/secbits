# Implementation Plan

Eight milestones in dependency order. Each is shippable and fully tested before the next begins. Tests are written alongside the code they cover.

Existing source files are noted where they already exist and need adaptation rather than creation.

---

## Milestone 1: Crypto Primitives

**Goal.** All cryptographic building blocks implemented and independently tested against reference vectors.

### Deliverables

| File | Status | What it provides |
|------|--------|-----------------|
| `src/lib/zbase32.js` | create | z-base-32 encode / decode |
| `src/lib/blob.js` | create | blob build and parse: `magic \|\| version \|\| salt \|\| ciphertext \|\| tag` |
| `src/crypto.js` | adapt | `encryptBlob` / `decryptBlob` using leancrypto HKDF + AEAD; Brotli helpers |

The leancrypto WASM bundle is pre-built in `leancrypto/`. No file other than `src/crypto.js` imports it directly.

### Tests

**`src/tests/leancrypto.test.js`** (exists — extend)
- HKDF-SHA3-512 known-answer test: fixed IKM + salt → expected output bytes.
- AEAD encrypt then decrypt: plaintext recovered exactly.
- Tamper ciphertext byte: throws `EBADMSG` (-9).
- Tamper tag byte: throws.
- Tamper AD byte: throws.
- Wrong key: throws.
- Empty plaintext: encrypt and decrypt succeed.

**`src/tests/zbase32.test.js`** (create)
- Encode → decode round-trip for random 256-bit input.
- Known vector: fixed 32-byte input → expected 52-character string.
- Non-alphabet character: decode rejects.
- Wrong length: decode rejects.

**`src/tests/blob.test.js`** (create)
- Build → parse round-trip: all fields recovered identically.
- Magic mismatch (`XY` not `SB`): parse throws before any crypto.
- Blob shorter than 132 bytes: parse throws.
- Version bytes extracted correctly.
- AD = `magic || version || salt` = exactly 68 bytes.

**`src/tests/crypto.test.js`** (exists — extend with blob-level tests)
- `encryptBlob` / `decryptBlob` round-trip with a fresh random key.
- Any single-byte modification anywhere in the blob causes throw.

---

## Milestone 2: Key Hierarchy

**Goal.** The three-level hierarchy root_master_key → UMK → entry_key → entry data is complete and tested at every level.

### Deliverables

| File | Status | What it provides |
|------|--------|-----------------|
| `src/crypto.js` | adapt | Add `decodeRootMasterKey`, `encryptUMK`, `decryptUMK`, `generateEntryKey`, `encryptEntryKey`, `decryptEntryKey`; update `encryptEntry` / `decryptEntry` to use entry_key as IKM instead of root_master_key |

`encryptEntry` pipeline: entry JSON → Brotli compress → HKDF(entry_key) + AEAD → blob.
`entry_key` is 64 raw random bytes, AEAD-encrypted with the UMK before leaving the browser.
UMK is 64 raw random bytes, AEAD-encrypted with root_master_key.

### Tests

**`src/tests/crypto-root-key.test.js`** (exists — verify coverage)
- Valid base64 ≥ 256 decoded bytes: accepted.
- 255 decoded bytes: rejected.
- Non-base64: rejected.
- Empty string: rejected.

**`src/tests/key-hierarchy.test.js`** (create)
- UMK round-trip: `encryptUMK(raw, RMK)` → `decryptUMK(blob, RMK)` = original bytes.
- Wrong RMK: `decryptUMK` throws.
- Entry key round-trip: `encryptEntryKey(raw, UMK)` → `decryptEntryKey(blob, UMK)` = original bytes.
- Wrong UMK: `decryptEntryKey` throws.
- Full 3-level round-trip: encrypt entry JSON → peel all three layers → recover original JSON.
- Each encryption of the same input produces a different blob (fresh salt each time).
- Tamper at entry_key blob: `decryptEntryKey` throws; `decryptEntry` never reached.
- Tamper at entry data blob: `decryptEntry` throws.

**`src/tests/crypto.test.js`** (exists — extend)
- Full pipeline round-trip: entry object → `encryptEntry` → `decryptEntry` → deep-equal.
- All three entry types (`login`, `note`, `card`).
- Commit hash embedded in snapshot survives round-trip.
- Wrong entry_key: throws at AEAD tag check.

**`src/tests/commit-hash.test.js`** (create)
- Same JSON always produces the same hash.
- Different JSON produces a different hash.
- Output is exactly 32 lowercase hex characters.
- SHA-256 of the empty string matches the known reference.

---

## Milestone 3: Worker Backend

**Goal.** Cloudflare Worker complete: Firebase auth, user_id derivation, rqlite client, schema migration, and all 14 API routes with full validation and ownership enforcement.

### Deliverables

| File | Status | What it provides |
|------|--------|-----------------|
| `worker/src/firebase.js` | adapt | `verifyFirebaseToken` unchanged; add `deriveUserId(uid)` = z-base-32(SHA3-256(uid)) |
| `worker/src/rqlite.js` | create | `query(sql, params)` and `execute(sql, params)` over HTTP Basic Auth |
| `worker/src/index.js` | rewrite | All 14 routes, user_id scoping, ownership checks, input validation |
| `worker/migrations/0001_initial.sql` | create | `key_types`, `users`, `key_store`, `entries`, `entry_history`, 3 indexes |
| `worker/migrations/0002_schema_version.sql` | create | `schema_version` table; inserts version 1 |
| `worker/scripts/migrate.js` | create | Reads current version, applies pending migrations in order, updates `schema_version` |

On every authenticated request: verify Firebase token → derive `user_id` → upsert `users` row → scope all queries to that `user_id`. No client-supplied identifier is trusted for authorization.

### Tests

**`worker/tests/firebase.test.js`** (create)
- Valid RS256 token, correct audience, unexpired: accepted; `uid` returned.
- Expired token: 401.
- Wrong `aud`: 401.
- Forged signature: 401.
- Malformed JWT: 401.
- `deriveUserId`: known Firebase UID → expected 52-character z-base-32 string.

**`worker/tests/rqlite.test.js`** (create, mocked HTTP)
- `query` sends `POST /db/query` with correct Basic Auth header.
- `execute` sends `POST /db/execute` with correct Basic Auth header.
- Parameterized body: `[[sql, param1, param2]]`.
- BLOB params sent as base64 strings.
- rqlite error key in result: `execute` throws.
- Network failure: both functions throw.

**`worker/tests/worker-entries.test.js`** (create, Miniflare or mocked rqlite)
- `GET /entries` for new user: `[]`.
- `GET /entries` only returns rows owned by the authenticated `user_id`.
- `POST /entries`: inserts entry row + initial history row atomically; returns 201 with `id` + `created_at`.
- `POST /entries` duplicate `id`: 409.
- `PUT /entries/:id`: updates `encrypted_data` and `updated_at`; appends history row.
- `PUT /entries/:id` at 20 commits: 21st deletes oldest before inserting.
- `DELETE /entries/:id`: sets `deleted_at`; absent from `GET /entries`; present in `GET /entries/trash`.
- `POST /entries/:id/restore`: clears `deleted_at`; returns to live list.
- `DELETE /entries/:id/purge`: removes entry row and all history rows.
- `GET /entries/:id/history`: rows ordered by `created_at` descending.
- Ownership: write/delete on another user's entry returns 404.
- Missing Bearer: 401 on every entry route.
- Invalid z-base-32 `id`: 400.
- `encrypted_data` < 132 decoded bytes: 400.
- `entry_key` < 196 decoded bytes: 400.

**`worker/tests/worker-keys.test.js`** (create)
- `GET /keys`: metadata only; no `encrypted_data` in response.
- `POST /keys`: inserts; returns 201.
- `POST /keys` with invalid `type`: 400.
- `POST /keys` with `type="peer_public"` and `peer_user_id` = own `user_id`: 400.
- `GET /keys/:key_id`: full record including `encrypted_data`.
- `GET /keys/:key_id` for another user's key: 404.
- `DELETE /keys/:key_id`: row removed.
- `GET /users/:user_id/public-key`: returns `{user_id, public_key}` if `own_public` exists; 404 otherwise.

**`worker/tests/migration.test.js`** (create, in-process SQLite)
- Fresh database: all migrations applied; `schema_version` = latest.
- Re-run: idempotent, no errors, version unchanged.
- All tables and indexes present.
- `key_types` seeded with exactly 5 rows.
- FK on `key_store.type`: insert with unknown type fails.

---

## Milestone 4: Frontend Core

**Goal.** Existing frontend code adapted for the new backend: key store session bootstrap, updated api.js, and entry CRUD working end-to-end with per-entry key wrapping.

### Deliverables

Most frontend files already exist. This milestone adapts them to the new backend contract (no vault_id, entry_key per entry, UMK from key_store).

| File | Status | What changes |
|------|--------|-------------|
| `src/App.jsx` | adapt | After sign-in: fetch `key_store`, decrypt UMK from the `umk` row; hold UMK in session state; generate and upload UMK + `own_public`/`own_private` pair on first login |
| `src/api.js` | adapt | Add `getKeys`, `addKey`, `getKey`, `deleteKey`, `getPeerPublicKey`; remove `vault_id` from all entry calls; add `entry_key`, `history_id`, `encrypted_snapshot` to create/update calls |
| `src/validation.js` | adapt | Remove `vault_id` validation; add z-base-32 ID format check |
| `src/components/AppSetup.jsx` | exists | Config upload and validation UI — verify it works without `vault_id` field |
| `src/components/EntryList.jsx` | exists | Entry list — verify it works with new response shape (no `type` column) |
| `src/components/EntryDetail.jsx` | exists | Entry detail — verify `type` is read from decrypted JSON, not response metadata |
| `src/components/LoginFields.jsx` | exists | Login typed form — no changes expected |
| `src/components/CardFields.jsx` | exists | Card typed form — no changes expected |
| `src/entryUtils.js` | adapt | Update `buildCreatePayload` / `buildUpdatePayload` to include `entry_key`, `history_id`, `encrypted_snapshot`; remove `vault_id` |
| `src/limits.js` | exists | No changes expected |

### Tests

**`src/tests/validation.test.js`** (exists — extend)
- `root_master_key`: valid base64 ≥ 256 decoded bytes accepted; short rejected.
- `worker_url`: HTTPS accepted; HTTP rejected.
- z-base-32 ID format: 52-character valid string accepted; wrong length rejected; non-alphabet rejected.
- `email` and `firebase_api_key`: non-empty accepted; empty rejected.

**`src/tests/api.test.js`** (create, mocked `fetch`)
- `getEntries()`: `GET /entries` with `Authorization: Bearer <token>`; returns array.
- `createEntry(data)`: `POST /entries` with `entry_key`, `encrypted_data`, `history_id`, `encrypted_snapshot`; returns `{id, created_at}`.
- `updateEntry(id, data)`: `PUT /entries/:id` without `entry_key`; returns `{id, updated_at}`.
- `deleteEntry(id)`: `DELETE /entries/:id`.
- `restoreEntry(id)`: `POST /entries/:id/restore`.
- `purgeEntry(id)`: `DELETE /entries/:id/purge`.
- `getHistory(id)`: `GET /entries/:id/history`; array returned.
- `getKeys()`: `GET /keys`; metadata array.
- `addKey(data)`: `POST /keys`; `{key_id, created_at}`.
- `getKey(keyId)`: `GET /keys/:key_id`; full record.
- `deleteKey(keyId)`: `DELETE /keys/:key_id`.
- Worker 401: all functions throw with recognizable auth error.
- Worker 400: throw with recognizable validation error.

**`src/tests/entry-lifecycle.test.js`** (create, mocked API)
- Create login entry: `entry_key` and `encrypted_data` in POST body; history row created.
- Decrypt after create: recover original JSON with type `"login"`.
- Update: `entry_key` not re-sent; `encrypted_data` updated; new history row appended.
- Decrypt updated entry: recover updated JSON.
- `entry_key` bytes identical across create and update (not regenerated).
- Soft delete → restore → soft delete → purge: final state correct at each step.

**`src/tests/export-data.test.js`** (exists — verify)
- `buildExportData` returns `{data, trash}`.
- Live entries: no `deleted_at`.
- Trashed entries: `deleted_at` present.
- Empty vault: `{data: [], trash: []}`.

---

## Milestone 5: Advanced Features

**Goal.** TOTP, version history with diff, search, password generator, trash view, and export complete. Most components already exist; wire them to the new backend and add missing tests.

### Deliverables

| File | Status | What changes |
|------|--------|-------------|
| `src/totp.js` | exists | Verify against RFC 6238 vectors; no changes expected |
| `src/components/HistoryDiffModal.jsx` | exists | Adapt to decrypt snapshots with `entry_key` from session |
| `src/components/PasswordGenerator.jsx` | exists | No changes expected |
| `src/components/TagsSidebar.jsx` | exists | Tags read from decrypted entry JSON; verify no `type` column dependency |
| `src/components/SettingsPanel.jsx` | exists | Add export action; key rotation triggers land in M6 |
| `src/components/SettingsList.jsx` | exists | No changes expected |
| `src/entryUtils.js` | adapt | Add `buildSnapshotPayload(entry)` that embeds commit hash inside snapshot JSON before encryption |

### Tests

**`src/tests/totp.test.js`** (exists — verify full RFC 6238 coverage)
- All six RFC 6238 SHA-1 reference codes match the spec.
- Output always exactly 6 digits.
- Different secrets produce different codes for the same timestamp.
- Adjacent 30-second windows differ.
- Invalid base32 secret: throws.

**`src/tests/history.test.js`** (create)
- Fresh entry: 1 commit (creation snapshot).
- After 20 edits: exactly 20 commits.
- 21st edit: oldest commit gone; still 20 commits.
- Commits ordered newest-first.
- Decrypt any snapshot with `entry_key`: recover entry JSON at that point in time.
- Commit hash in snapshot = `hex(SHA-256(snapshotJson)).slice(0,32)`.

**`src/tests/search.test.js`** (create)
- Title substring match: entry returned.
- Username substring match: entry returned.
- Case-insensitive: `"github"` matches title `"GitHub"`.
- No match: `[]`.
- Empty query: all live entries.
- Tag filter: only entries with that tag.
- Combined text + tag: intersection.
- Trashed entries excluded from all results.

**`src/tests/export-data.test.js`** (exists — extend)
- Export includes all live entries and all trashed entries.
- Each entry's decrypted fields present (type, title, fields, tags, `_commits`).

---

## Milestone 6: Key Store and Rotation

**Goal.** Key store management UI, root master key rotation (re-encrypts UMK blob only), and UMK rotation (re-encrypts all entry_key blobs) are complete and tested.

### Deliverables

| File | Status | What it provides |
|------|--------|-----------------|
| `src/components/KeyStoreManager.jsx` | create | List keys by type; add emergency key; generate and upload asymmetric key pair |
| `src/components/KeyRotation.jsx` | create | RMK rotation UI (re-encrypt UMK blob, prompt for new root_master_key); UMK rotation UI (re-encrypt all entry_key blobs) |
| `src/components/SettingsPanel.jsx` | adapt | Add key rotation and key store panels |

### Tests

**`src/tests/key-rotation.test.js`** (create)
- RMK rotation: `decryptUMK(encryptUMK(raw, newRMK), newRMK)` = original UMK bytes.
- RMK rotation: entry_key blobs and encrypted_data blobs unchanged.
- Old RMK: `decryptUMK(newBlob, oldRMK)` throws.
- UMK rotation: all entry_key blobs re-encrypted; same 64-byte raw keys recovered with new UMK.
- UMK rotation: encrypted_data and encrypted_snapshot blobs unchanged.
- Old UMK: `decryptEntryKey(reEncryptedBlob, oldUMK)` throws.
- Interrupted UMK rotation (5 of 10 entry_keys updated): retry re-encrypts remaining 5; final state consistent.

---

## Milestone 7: Sharing

**Goal.** Cross-user public key lookup and sharing flow: a user can fetch another user's public key, store it as a `peer_public` record, and use it to encrypt entries for sharing.

### Deliverables

| File | Status | What it provides |
|------|--------|-----------------|
| `src/components/SharingPanel.jsx` | create | Input a peer `user_id`; fetch their public key via `GET /users/:user_id/public-key`; store as `peer_public` in key_store; encrypt a selected entry's `entry_key` with the peer's public key |
| `src/api.js` | adapt | `getPeerPublicKey(userId)` calls `GET /users/:user_id/public-key` |

Worker's `GET /users/:user_id/public-key` route is already specified in backend.md and implemented in M3.

### Tests

**`worker/tests/sharing.test.js`** (create)
- `GET /users/:user_id/public-key` for a user with `own_public`: 200 with `public_key`.
- `GET /users/:user_id/public-key` for user with no `own_public`: 404.
- `POST /keys` with `type="peer_public"` and valid `peer_user_id`: key stored; retrievable via `GET /keys/:key_id`.
- `POST /keys` with `type="peer_public"` and `peer_user_id` = own `user_id`: 400.

**`src/tests/e2e.test.js`** (create, mocked Worker)
- Full session: load config → sign in → fetch entries and keys → create login entry → update → history (2 commits) → delete → restore → purge → entry gone.
- TOTP entry: create login entry with TOTP secret → code generated inline.
- Key rotation: sign in → rotate RMK → sign in again with new RMK → all entries still decrypt.
- Export: 3 entries created, 1 soft-deleted → export has 2 in `data`, 1 in `trash`.
- Wrong RMK at login: UMK decryption fails; session does not load.
- Expired Firebase token mid-session: next API call returns 401; session cleared.
- Sharing: fetch peer public key → `peer_public` row stored → `entry_key` encrypts with peer's key.

---

## Milestone 8: Deployment

**Goal.** CF Pages and Worker deployment configured and scripted, wrangler config finalized.

### Deliverables

| File | Status | What it provides |
|------|--------|-----------------|
| `worker/wrangler.toml` | create from example | Worker name, account_id, routes; no R2 bindings |

**Deployment sequence:**
1. `wrangler secret put FIREBASE_PROJECT_ID / RQLITE_URL / RQLITE_USERNAME / RQLITE_PASSWORD`
2. Apply `worker/migrations/0001_initial.sql` against rqlite to initialize schema.
3. `wrangler deploy`

**CF Pages:** build command `npm run build`, output directory `dist`, environment variable `VITE_WORKER_URL` = deployed Worker URL.

No automated tests; validated by a successful end-to-end deployment.
