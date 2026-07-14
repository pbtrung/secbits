# Testing

Testing strategy for the current implementation, with an explicit line between what the automated suite actually covers, what's inherently manual or live service only, and what's a real, addable gap. Based on a manual file by file read through, since no coverage tool is installed; treat percentages or "covered"/"not covered" claims here as a snapshot, not a measured baseline.

## Tooling

- Vitest, `environment: 'node'`, tests under `src/tests/` as `.test.ts` (see CLAUDE.md, Layout).
- TypeScript, checked separately from the test suite: `npm run typecheck` (`tsc --noEmit`, `strict: true`) catches shape mismatches statically, which is a different, complementary net to the runtime assertions below — see `docs/tech_stack.md` for why this is a dedicated script rather than part of the build.
- No jsdom/happy-dom and no `@testing-library/react` are configured, so no React component, any `.tsx` file, can be rendered or asserted on in this suite as it stands. That is a tooling gap, not a decision; most components have little pure logic to test anyway, but a few (see below) have non-trivial logic sitting behind a `.tsx` extension that this gap puts out of reach.
- No coverage tool installed (`@vitest/coverage-v8` is not a dependency). The line-by-line claims in this doc come from reading every test file against its source, not from a measured report.
- No server side test suite: no Worker or other backend component to test (see docs/architecture.md, Backend: none, by design).

## What the automated suite covers well

- **Blob format and AEAD** (`blob.test.ts`, `crypto.test.ts`): round trip, magic/length fast-fail, tamper detection swept across every single byte position of a payload, wrong-key rejection, AD covering magic/version/salt, `encryptBlob`'s input type guard.
- **Blob version dispatch** (`blob.test.ts`): a minor version bump under the current major version still decodes; an unrecognized major version is rejected with an explicit error rather than misdecoded (`verifyBlobVersion` in `src/lib/blob.ts`).
- **Compression** (`crypto.test.ts`): `compressJson`/`decompressJson` round trip a representative JSON value directly, not just transitively through `encryptEntry`/`decryptEntry`.
- **Commit hash** (`commit-hash.test.ts`): canonicalization is key-order independent, one known-answer hash value, tamper detection.
- **Master key format** (`crypto-root-key.test.ts`): `decodeRootMasterKey`/`decodeBackupMasterKey` accept/reject boundaries (255 vs 256 vs 300 bytes), invalid base64.
- **Key hierarchy composition** (`key-hierarchy.test.ts`): full `root_master_key` → UMK → `entryKey` → entry round trip, fresh salt per encryption, tamper at each layer, `decryptUMK`/`decryptEntryKey`'s wrong-decrypted-length rejection (`'Invalid UMK'`/`'Invalid entry key'`, not just the AEAD-failure path), `generateUMK` sanity.
- **leancrypto WASM primitives** (`leancrypto.test.ts`): known-answer vectors for the AEAD/hash/HKDF bindings directly, independent of how `crypto.ts` uses them; correctly scoped to the primitive layer per its own header comment.
- **TOTP** (`totp.test.ts`): full RFC 6238 vector set plus base32 edge cases.
- **Config validation** (`validation.test.ts`): full branch coverage of `validateConfig`, including `backup_master_key`'s conditional requirement when a cloud destination is configured, plus `isHttpUrl`/`isHttpsUrl`.
- **Search/filter** (`search.test.ts`): `filterEntries`'s substring match, case-insensitivity, and tag filter.
- **Entry utilities** (`entry-utils.test.ts`): `formatExact`/`formatDeletedLabel`'s date formatting and relative-day labeling (today/yesterday/N days/older, using `vi.useFakeTimers` for a fixed "now"), `normalizeCustomFields`'s legacy `hiddenFields` fallback, `normalizeEntry`'s defaulting, `ENTRY_TYPE_META` staying in sync with `ENTRY_TYPES`.
- **`db.ts`'s pure logic slice** (`db-pure.test.ts`): `fieldsChanged`, `stripNestedHistory`, `buildCommitList` (parent/changed wiring across a commit chain, oldest has no parent, nested history stripped), `getVaultStats`, and `buildExportData`'s per-entry history self-filtering (the current version is excluded from its own exported history) and versioned export shape. These three internals are exported from `db.ts` specifically so they're reachable from a test, since they have no dependency on InstantDB at all.
- **`buildCloudBackupBlob`** (`backup.test.ts`): round trips under the same `backup_master_key`, fails to decrypt under a different one.
- **`uploadAllBackupDestinations`** (`s3.test.ts`): with `aws4fetch`'s `AwsClient` mocked, verifies the orchestration property that actually matters here without needing real buckets: one destination failing doesn't throw or block the others, and results are reported per destination (R2 and each `s3_config` entry), not combined.

## `db.ts`: everything past the pure-logic slice is untested

Every exported function that touches InstantDB (`ensureKeyStore`, `fetchUserEntries`, `createUserEntry`, `updateUserEntry`, `deleteUserEntry`, `restoreDeletedUserEntry`, `restoreEntryVersion`, `rotateRootMasterKey`, `rotateUserMasterKey`, `signIn`, and more) has zero test coverage. All of it is fused to real `db.getAuth()`/`db.transact()`/`db.queryOnce()`/`db.auth.signInWithIdToken()` calls; there is no mock of `@instantdb/react` anywhere in the repo, so none of this is testable today without either a live InstantDB app or writing a mock layer, neither of which exists. Typing these calls against the schema (`npm run typecheck`) catches shape mismatches at compile time regardless, which is the main practical mitigation for this gap; see `docs/tech_stack.md`.

## React components: untestable as configured

No jsdom, no `@testing-library/react`, so every `.tsx` file is out of reach for this suite regardless of how much pure logic it contains. Two components bury non-trivial pure logic that a future pass could extract (and export) to cover independently of any rendering: `HistoryDiffModal.tsx`'s LCS based line-diff implementation, and `PasswordGenerator.tsx`'s entropy/strength estimation.

## Live or manual only, correctly outside the automated suite

- **`instant.perms.ts`**: needs a real InstantDB app with at least two authenticated test users. Test plan:
  - User A cannot view, update, or delete User B's `entries`, `keyStore`, or `$files` rows (entry data or history).
  - User A cannot create an `entries` or `keyStore` row with `owner` set to User B.
  - User A cannot upload an entry data file or a history file at a `path` not prefixed with their own `auth.id`, even if linked to one of their own entries.
  - User A cannot update one of their own rows to reassign `owner` to User B; `!('owner' in request.modifiedFields)` rejects any update that touches `owner` at all.
  - No user can update a history `$files` row; only create or delete succeed.
  - User A can delete their own history files.
- **Cloud backup upload** against real R2 and each configured S3 compatible destination: SigV4 signing and CORS are both real failure points for a client direct upload, with no server to fall back on if either is wrong; this can't be verified against a mock. (The independent-per-destination orchestration around this _is_ covered, mocked, per above; only the "did the bytes actually reach the bucket" question is live-only.)
- **Firebase/InstantDB auth and session flow**: `signIn`'s Firebase exchange, `ensureKeyStore`'s first-run multi-tab race handling, all need a real Firebase project and InstantDB app.

## Not covered

- Load or performance testing.
- The deferred sharing and one time link features (see docs/features.md, Deliberately deferred), since neither is implemented.
- All of `db.ts` beyond its pure-logic slice: key rotation atomicity, save/create/update flow, history cap pruning, trash retention purge, the full entry lifecycle (see above).
- All React components: no rendering tooling configured (see above).
