# Testing

## Test Runner

```bash
npx vitest run        # single run, all suites
npx vitest            # watch mode
npx vitest run --reporter=verbose   # detailed output per test
```

Worker tests (Milestone 3) run under Miniflare or with mocked rqlite responses:

```bash
cd worker && npx vitest run
```

## Test Files

### Milestone 1: Crypto Primitives

| File | Covers |
|------|--------|
| `src/tests/leancrypto.test.js` | Raw HKDF-SHA3-512 KAT vectors; Ascon-Keccak-512 AEAD encrypt/decrypt; tamper detection at ciphertext, tag, and AD; wrong key rejection; empty plaintext |
| `src/tests/zbase32.test.js` | Encode/decode round-trip for 256-bit input; known vector; non-alphabet character rejection; wrong-length rejection |
| `src/tests/blob.test.js` | Build/parse round-trip; magic mismatch fast-fail; blob shorter than 132 bytes rejected; version extraction; AD = 68 bytes |
| `src/tests/crypto.test.js` | `encryptBlob` / `decryptBlob` round-trip; any single-byte modification causes throw |

### Milestone 2: Key Hierarchy

| File | Covers |
|------|--------|
| `src/tests/crypto-root-key.test.js` | `decodeRootMasterKey`: valid ≥256 decoded bytes accepted; 255 bytes rejected; non-base64 rejected; empty rejected |
| `src/tests/key-hierarchy.test.js` | UMK wrap/unwrap with RMK; entry_key wrap/unwrap with UMK; wrong RMK throws; wrong UMK throws; full 3-level round-trip; each encryption produces a different blob |
| `src/tests/crypto.test.js` | Full entry JSON → compress → encrypt → decrypt → decompress → parse round-trip; all three entry types; commit hash in snapshot survives round-trip; wrong entry_key throws |
| `src/tests/commit-hash.test.js` | Deterministic output for same input; different input → different hash; always 32 lowercase hex chars; SHA-256 of empty string matches reference |

### Milestone 3: Worker Backend

| File | Covers |
|------|--------|
| `worker/tests/firebase.test.js` | Valid RS256 token accepted; expired token 401; wrong audience 401; forged signature 401; malformed JWT 401; `deriveUserId` known UID → expected 52-character z-base-32 string |
| `worker/tests/rqlite.test.js` | Basic Auth header on every request; parameterized body format; BLOB params as base64; rqlite error response throws; network failure throws |
| `worker/tests/worker-entries.test.js` | All entry routes (correct responses, auth enforcement, ownership); history cap at 20; `entry_key` and `encrypted_data` size validation; missing token 401; invalid z-base-32 ID 400 |
| `worker/tests/worker-keys.test.js` | All key routes + public-key route; `GET /keys` omits `encrypted_data`; invalid key type 400; `peer_user_id` = own `user_id` 400; cross-user key access 404 |
| `worker/tests/migration.test.js` | All tables and indexes created; `key_types` seeded with 5 rows; idempotent re-run; `schema_version` correct after full migration; FK enforcement on `key_store.type` |

### Milestone 4: Frontend Core

| File | Covers |
|------|--------|
| `src/tests/validation.test.js` | Config field validators (worker_url, email, root_master_key, firebase_api_key); z-base-32 ID format check; URL field validation |
| `src/tests/api.test.js` | All `api.js` functions with mocked `fetch`; correct HTTP method, path, and headers for each call; 401 and 400 Worker responses throw with typed errors |
| `src/tests/entry-lifecycle.test.js` | Create → update → delete → restore → purge; `entry_key` unchanged across updates; `encrypted_data` and `encrypted_snapshot` both present on create |
| `src/tests/export-data.test.js` | `buildExportData` shape: `data` + `trash` arrays; no `deleted_at` in live entries; `deleted_at` present in trashed entries; empty vault |

### Milestone 5: Advanced Features

| File | Covers |
|------|--------|
| `src/tests/totp.test.js` | All six RFC 6238 reference codes (SHA-1, 30 s, 6-digit); always 6 digits; different secrets produce different codes; adjacent windows differ; invalid base32 throws |
| `src/tests/history.test.js` | Fresh entry has 1 commit; cap at 20; 21st edit drops oldest; commits ordered newest-first; snapshot decrypts to correct JSON at each point; commit hash verified after decrypt |
| `src/tests/search.test.js` | Title substring match; username match; case-insensitive; no match returns `[]`; empty query returns all live entries; tag filter; combined text + tag; trash excluded |
| `src/tests/export-data.test.js` | Extended: all live and trashed entries included; each entry's decrypted fields present (type, title, fields, tags, commits) |

### Milestone 6: Key Store and Rotation

| File | Covers |
|------|--------|
| `src/tests/key-rotation.test.js` | RMK rotation re-encrypts UMK only (entry_key and encrypted_data blobs untouched); old RMK rejected after rotation; UMK rotation re-encrypts all entry_keys (encrypted_data untouched); old UMK rejected; interrupted rotation is retriable |

### Milestone 7: Sharing

| File | Covers |
|------|--------|
| `worker/tests/sharing.test.js` | `GET /users/:user_id/public-key` returns 200 with `public_key`; 404 if no `own_public`; `peer_public` stored and retrievable; `peer_user_id` = own `user_id` rejected with 400 |
| `src/tests/e2e.test.js` | Full session (create → update → history → delete → restore → purge); TOTP live code; key rotation end-to-end; export shape; wrong RMK at login; expired token mid-session; sharing flow end-to-end |

### Milestone 8: Deployment

| File | Covers |
|------|--------|
| `worker/tests/migration.test.js` | Full coverage: `migrate.js` applies all migrations in order; `schema_version` = latest; idempotent re-run; all tables and indexes present; `key_types` seeded with 5 rows; FK enforcement on `key_store.type`; simulated partial failure re-runs from correct point |

## Critical Path Coverage

### Cryptographic correctness

1. `encryptEntry` / `decryptEntry` round-trip: entry JSON → compress → HKDF(entry_key) + AEAD → decrypt → decompress → parse produces identical output.
2. Any single-byte modification to `magic`, `version`, `salt`, `ciphertext`, or `tag` causes authentication failure before any plaintext is returned.
3. Decryption with the wrong `entry_key` fails at the AEAD tag check; no plaintext is returned.
4. Decryption with the wrong UMK fails at the entry_key blob's AEAD tag check.
5. Decryption with the wrong root_master_key fails at the UMK blob's AEAD tag check.
6. Each encryption of the same plaintext produces a different blob (fresh 64-byte salt each time).
7. Commit hash embedded in `encrypted_snapshot` matches `hex(SHA-256(snapshotJson)).slice(0,32)` after decrypt.

### Key hierarchy

8. Full 3-level hierarchy: root_master_key → UMK → entry_key → entry data — all levels encrypt, wrap, and unwrap correctly.
9. RMK rotation re-encrypts only the UMK blob; all entry_key and encrypted_data blobs are identical before and after.
10. UMK rotation re-encrypts all entry_key blobs; all encrypted_data and encrypted_snapshot blobs are identical before and after.

### Worker auth and scoping

11. Every route except `GET /health` rejects requests missing a valid Firebase Bearer token with 401.
12. All rqlite queries are scoped to the Worker-derived `user_id`; queries for another user's rows return nothing.
13. Write and delete operations on rows not owned by the authenticated user return 404 before any SQL is executed.
14. All rqlite queries use parameterized statements; no string interpolation used to construct SQL.

### Worker input validation

15. `id`, `key_id`, `history_id` must be valid 52-character z-base-32 strings.
16. `encrypted_data` and `encrypted_snapshot` must be valid base64 with at least 132 decoded bytes.
17. `entry_key` must be valid base64 with at least 196 decoded bytes.
18. `type` for `key_store` rows must be one of the five values in `key_types`; rejected with 400 otherwise.
19. `peer_user_id` required for `peer_public` type; must not equal the authenticated user's own `user_id`.

### Entry lifecycle

20. First login (`GET /entries`) for a new user returns an empty array; no error.
21. Create entry: single `POST /entries` atomically inserts both the entry row and the initial history row.
22. Update entry: `entry_key` is not re-sent or changed; only `encrypted_data` and a new history row change.
23. History cap: after 20 commits, inserting the 21st deletes the oldest commit row; total stays at 20.
24. Trash lifecycle: `DELETE` sets `deleted_at`; `POST restore` clears it; `DELETE purge` removes the entry row and all history rows.

### Config and TOTP

25. Config JSON with `root_master_key` shorter than 256 decoded bytes is rejected at startup.
26. TOTP codes match all six RFC 6238 SHA-1 reference vectors.

## Regression Priorities

Run these checks on every change touching crypto, the Worker, or the session flow:

- Login: `GET /entries` with a valid token returns the correct entry list (or `[]` for a new user).
- Save: `POST /entries` or `PUT /entries/:id` writes the correct blob to rqlite; history row appended.
- Decrypt: entries fetched from rqlite decrypt correctly with the session's UMK and each entry's `entry_key`.
- Tamper: any modification to any stored blob causes decryption to throw; the app surfaces an error and does not show partial data.
- Auth: removing or expiring the Firebase token causes the next API call to fail with 401; the session is cleared.
- Parameterized SQL: no rqlite query contains string-interpolated user input.
- Root master key validation: a short or non-base64 `root_master_key` in config is caught before any network call.
- TOTP: all six RFC 6238 reference codes pass on every run (no floating-point or endianness regression).
- History cap: after 20 commits a new edit results in exactly 20 rows in `entry_history`, not 21.
- Schema migration: `migrate.js` run against a fresh database produces all expected tables, indexes, and `key_types` rows.
