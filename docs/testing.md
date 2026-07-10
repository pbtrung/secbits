# Testing

Testing strategy for the current implementation.

## Tooling

- Vitest for unit and integration tests, under `src/tests/` (see CLAUDE.md, Layout).
- No server side test suite: there is no Worker or other backend component to test (see docs/architecture.md, Backend: none, by design).

## Crypto pipeline

- Round trip: encrypt then decrypt for every blob type (`keyStore.umkBlob`, `entries.entryKey`, `entries.encryptedData`, `entryHistory.encryptedSnapshot`, cloud backup blob) recovers the original payload.
- Tamper detection: flipping a single bit anywhere in a blob, magic, version, salt, ciphertext, or tag, causes decryption to fail before any plaintext is returned (see docs/crypto.md, AEAD Additional Data).
- Wrong key rejection: decrypting with an incorrect `root_master_key`, UMK, or `entryKey` fails at the AEAD tag check.
- Version dispatch: a v1.0 blob decodes through the v1.0 path; an unrecognized major version is rejected rather than misdecoded (see docs/crypto.md, Versioning Strategy).
- Commit hash: computing then verifying the hash over a canonical JSON snapshot is deterministic and round trips; a tampered snapshot fails verification (see docs/crypto.md, Commit Hash).
- Fast fail: a blob with the wrong magic bytes is rejected before any AEAD or HKDF work runs.

## Key hierarchy

- `root_master_key` rotation re encrypts `keyStore.umkBlob`; existing `entries`, `entryHistory`, and past cloud backup blobs all remain decryptable unchanged.
- UMK rotation re encrypts every `entryKey`; assert this happens as a single all or nothing operation. A simulated failure partway through must leave the old UMK and every `entryKey` still valid, never a mix of old and new (see docs/crypto.md, Key Rotation).
- `backup_master_key` is config only, with nothing stored to rotate; assert a backup object uploaded under one `backup_master_key` value still decrypts under that same value, and fails to decrypt under a different one.

## Entry lifecycle

- Save creates or updates `entries.encryptedData` and appends an `entryHistory` row.
- History cap: once an entry has more than 20 history rows, the oldest is pruned, verified client side after decrypting each row's timestamp.
- Trash: setting the encrypted `deletedAt` marker hides an entry from the active vault view; purge removes entries past the retention window, verified client side after decrypting each candidate.

## Backup

- Local export produces valid, complete JSON that round trips back into the same in memory vault state; no field is silently dropped.
- Cloud backup blob: Brotli compress, AEAD encrypt under `backup_master_key`, and decrypt round trips to the original vault JSON, same as any other blob type.
- Cloud backup upload is exercised against real test buckets, R2 and each configured S3 compatible destination, not mocked, since SigV4 signing and CORS are both real failure points for a client direct upload; there is no server to fall back on if either is wrong.
- With more than one `s3_config` entry, a failure uploading to one destination must not block or roll back uploads to the others, and the reported result must be per destination, not a single combined success or failure.

## Permission rules

`instant.perms.ts` cannot be unit tested in isolation; it needs to run against a real InstantDB app, a dedicated test or dev app, not production. Test plan, using at least two authenticated test users:

- User A cannot view, update, or delete User B's `entries`, `entryHistory`, or `keyStore` rows.
- User A cannot create an `entries` or `keyStore` row with `owner` set to User B.
- User A cannot update one of their own rows to reassign `owner` to User B; `!('owner' in request.modifiedFields)` rejects any update that touches `owner` at all.
- No user can update an `entryHistory` row; only create or delete succeed.
- User A can delete their own `entryHistory` rows through the `entry.owner` ref chain, not just direct ownership.

## Not covered

- Load or performance testing.
- The deferred sharing and one time link features (see docs/features.md, Deliberately deferred), since neither is implemented.
