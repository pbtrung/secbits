# Implementation Plan — SecBits

## Status

| Milestone | Status    | Scope                                                        |
|-----------|-----------|--------------------------------------------------------------|
| M1        | Done      | Project skeleton, CLI wiring, error types, logging           |
| M2        | Done      | SQLite schema, CRUD, `user_version` safety check             |
| M3        | Done      | leancrypto HKDF + Ascon-Keccak-512 AEAD wrappers, brotli    |
| M4        | Done      | `init`, root key validation, session auth, zeroization       |
| M5        | Done      | Entry key wrap, history JSON, commit hash, dedup, restore, delta overflow |
| M6        | Done      | `ls/show/insert/edit/rm/history/restore/totp/export`, fuzzy path, `path_hint` validation |
| M7        | Done      | Interactive prompts: masked input, password confirmation, TOTP validation, multi-line notes, custom fields loop, optional-field gates, post-write summary |
| M8        | Pending   | S3 backup push/pull, config `[targets]` parsing, `backup_on_save` trigger |
| M9        | Pending   | Unicode NFC normalization, field-level hashes, diff hardening |
| M10       | Pending   | `lcr_kyber_x448` KEM wrappers, share commands               |
| M11       | Pending   | Packaging, release docs                                      |

---

## M8 — Backup

**Exit criteria:**
1. `[targets.<name>]` sections parse correctly from TOML config.
2. `backup push --target <name>` encrypts and uploads local DB.
3. `backup push --all` pushes to all configured targets.
4. `backup push` with neither flag returns a CLI arg error.
5. `backup push --all` with zero configured targets → `BackupTargetNotConfigured`.
6. `backup pull --target <name>` downloads, decrypts, and atomically replaces local DB.
7. `backup pull` requires confirmation; cancellation leaves existing DB intact.
8. Round-trip: push → delete local DB → pull → entries intact.
9. `backup_on_save = true` auto-triggers push after `insert`, `edit`, `restore`.

**Test coverage:**
- `backup push --all` with no targets → `BackupTargetNotConfigured`.
- `backup push` with neither flag → CLI arg error.
- Round-trip integration test (requires mock or live S3 target).
- `backup pull` cancellation leaves existing DB intact.
- `backup_on_save` auto-trigger after each write command.

---

## M9 — Diff Accuracy

**Exit criteria:**
1. Unicode NFC normalization applied to all text fields before compare and storage.
2. Field-level hashes computed and stored in commit metadata.
3. URL normalization: lowercase host + strip trailing slash.
4. Tag comparison: case-insensitive set.
5. `customFields` matched by `id`, not array index.

**Test coverage:**
- Array reorder without semantic change → no commit appended.
- Whitespace-only edit → no commit appended.
- URL trailing-slash equivalence.
- Tag case-insensitivity.
- Unicode NFC normalization edge cases.

---

## M10 — Entry Sharing

**Exit criteria:**
1. `hybrid_kem_keypair / hybrid_kem_enc / hybrid_kem_dec` wrappers in `crypto.rs` pass round-trip test.
2. `share-init` stores keypair; idempotent with confirmation prompt.
3. `share-pubkey` exports raw public key; returns `ShareKeysNotInitialized` if not run.
4. `share <path>` produces a valid `.sbsh` payload; file and S3 relay modes work.
5. `share-receive` decrypts payload and inserts entry; recipient vault matches sender's snapshot.
6. All negative tests pass (tampered KEM ct, wrong recipient, truncated payload, wrong pk size).

**Test coverage:**
- Hybrid KEM round-trip: encapsulate → decapsulate → shared secret matches.
- Share payload encode/decode round-trip.
- `share-pubkey` before `share-init` → `ShareKeysNotInitialized`.
- Tampered KEM ciphertext → `ShareDecryptFailed`.
- Wrong recipient username in payload → `ShareNotForThisUser`.
- Truncated payload → `InvalidSharePayload`.
- Public key file wrong length → `InvalidRecipientPublicKey`.
- Full share round-trip integration: Alice shares → Bob receives → snapshot matches.

---

## M11 — Release

**Exit criteria:**
1. All quality gates pass: no failing tests, no unresolved crypto/auth defects.
2. `secbits --help` output matches implemented command surface.
3. README Quick Start walkable from a clean system.

---

## Quality Gates

1. No failing tests in unit, integration, or CLI suites.
2. All security invariants tested: auth failures, tag tamper rejection, key unwrap failures.
3. No plaintext secrets in logs or stdout (except `export` warning).
4. Command help text matches implemented behavior.
