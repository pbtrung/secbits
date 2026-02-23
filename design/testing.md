> Part of [Design Docs](../design.md).

# Testing

## Why these tests matter

1. Encryption correctness: secrets must decrypt to the exact original bytes with no loss or mutation.
2. Integrity enforcement: AEAD authentication must reject any tampered blob before returning plaintext.
3. Interoperability: TOTP output must match standard RFC vectors so authenticator codes are reliable.
4. WASM correctness: leancrypto primitives are verified against known test vectors before any application code relies on them.
5. Key hierarchy correctness: the multi-layer key derivation and wrapping chain (root key → UMK → doc key) must round-trip faithfully; a regression at any layer silently locks users out of all their data.
6. Login gate enforcement: `decodeRootMasterKey` is the first validation executed at every login; a bug here would either accept weak keys or incorrectly reject valid users.
7. Entry history integrity: the compress+encrypt path used on every save is distinct from the raw blob path and must be separately verified to round-trip correctly with tamper detection.
8. Delta correctness: snapshot deltas are the sole basis for version-history reconstruction and restore; incorrect delta logic would silently corrupt the diff viewer and restore results.
9. Format edge cases: single-commit history and the 20-commit truncation cap are explicit invariants that are easy to break during refactors without a dedicated guard.

## How the crypto tests work

1. Generate random `keyBytes` and a random 128-byte plaintext using `crypto.getRandomValues`.
2. Encrypt plaintext to blob `c` with `encryptBytesToBlob` (async).
3. Decrypt blob `c` to `d` with `decryptBlobBytes` (async).
4. Compare plaintext and `d` byte-by-byte.
5. Verify blob length equals `SALT_LEN(64) + plaintext.length + TAG_LEN(64)` and that the tag bytes are non-zero.
6. Tamper one byte of the tag and verify `decryptBlobBytes` rejects the blob.
7. Convert a known byte array (`[0, 1, 255]`) through `bytesToB64` and assert the result equals `"AAH/"`. Round-trip by decoding through `atob` and asserting byte equality.

## How the root master key tests work

`decodeRootMasterKey` is the first call made when a user loads their config file. It validates that the raw root master key decodes to a usable size before any crypto operations begin.

1. Base64-encode a byte array of exactly 256 bytes and call `decodeRootMasterKey` → assert it returns a `Uint8Array` of length 256.
2. Base64-encode a byte array of 300 bytes and call `decodeRootMasterKey` → assert it returns a `Uint8Array` of length 300 (accepts over the minimum).
3. Base64-encode a byte array of 254 bytes and call `decodeRootMasterKey` → assert it throws with a message containing `"at least 256 bytes"`.
4. Pass a non-base64 string (`"!!!invalid"`) → assert it throws.

## How the user master key crypto tests work

These tests exercise the full first-login and returning-user flows.

1. Generate a random 256-byte root master key with `crypto.getRandomValues`.
2. Call `setupUserMasterKey(rootKeyBytes)` → assert `userMasterKeyBlob` is exactly 192 bytes (`SALT_LEN(64) + UMK_LEN(64) + TAG_LEN(64)`).
3. Call `verifyUserMasterKey(rootKeyBytes, userMasterKeyBlob)` → assert the returned bytes equal `userMasterKey` byte-by-byte.
4. Call `verifyUserMasterKey` with a different random root key against the same blob → assert it throws `"Wrong root master key"`.
5. Call `verifyUserMasterKey` with a `Uint8Array` shorter than 192 bytes → assert it throws `"Invalid stored user_master_key data"`.

## How the entry key wrap/unwrap tests work

Each Firestore document stores an `entry_key` field — the per-entry doc key encrypted under the user master key. These tests verify that second key-wrapping layer independently of the higher-level entry CRUD.

1. Generate a random 64-byte `userMasterKey` and a random 64-byte `docKey`.
2. Call `wrapEntryKey(userMasterKey, docKey)` → assert the returned blob is 192 bytes (`SALT(64) + ciphertext(64) + TAG(64)`).
3. Call `unwrapEntryKey(userMasterKey, wrappedBlob)` → assert the result equals `docKey` byte-by-byte.
4. Call `wrapEntryKey` with a 32-byte `docKeyBytes` → assert it throws `"docKeyBytes must be 64 bytes"`.
5. Tamper one byte of `wrappedBlob` before calling `unwrapEntryKey` → assert it throws (AEAD authentication failure).

## How the entry history crypto tests work

`encryptEntryHistoryWithDocKey` and `decryptEntryHistoryWithDocKey` are called on every entry save and load. They add Brotli compression and JSON serialisation on top of the raw AEAD layer, so they need a separate round-trip test.

1. Construct a sample history object (title, password, notes, a urls array, and a commits array with two commits).
2. Generate a random 64-byte `docKey`.
3. Call `encryptEntryHistoryWithDocKey(docKey, history)` to produce `encryptedBlob`.
4. Call `decryptEntryHistoryWithDocKey(docKey, encryptedBlob)` → deep-equal the result to the original `history` object (confirms JSON + Brotli + AEAD all round-trip without data loss).
5. Clone `encryptedBlob`, flip one byte in the ciphertext region, and call `decryptEntryHistoryWithDocKey` → assert it throws (tamper detected before any plaintext is returned).

## How the TOTP tests work

1. Use the RFC 6238 SHA-1 shared secret (`12345678901234567890`, base32-encoded).
2. Call `generateTOTPForCounter(secret, counter)` with fixed counters from RFC vectors.
3. Assert the returned 6-digit code matches the expected values.
4. Include larger counter cases to ensure correct 8-byte big-endian counter handling and dynamic truncation behavior.

## How the base32 decode tests work

`base32Decode` is the parser that converts TOTP secrets typed by the user into raw bytes. Incorrect decode produces wrong HMAC input and silently generates wrong codes.

1. Decode the RFC 6238 SHA-1 secret (`GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ`) → assert the resulting bytes match the known hex `3132333435363738393031323334353637383930` (ASCII `12345678901234567890`).
2. Decode a secret with `=` padding appended → assert the result equals the unpadded decode (padding is stripped silently).
3. Decode a secret with embedded spaces, `-`, and `_` separators → assert they are stripped and the result equals the clean decode.
4. Decode a lowercase version of the same secret → assert it equals the uppercase decode (case-insensitive).
5. Pass a string containing characters outside the base32 alphabet (`0`, `1`, `8`, `9`, `!`) → assert `base32Decode` returns `null`.

## How the `generateTOTP` smoke tests work

`generateTOTP` is the function called in the UI on every render tick. Its clock dependency makes vector testing impractical; instead the tests verify output format and error behavior.

1. Call `generateTOTP(RFC6238_SHA1_SECRET)` → assert the return value is a string matching `/^\d{6}$/` (exactly 6 digits, zero-padded).
2. Call `generateTOTP("!!!invalid")` → assert it returns `null`.

## How the snapshot delta tests work

`buildSnapshotDelta` and `applySnapshotDelta` reduce storage size for older commits and reconstruct full snapshots at read time. Both are exported via `__historyFormatTestOnly`.

1. **Changed field:** call `buildSnapshotDelta(A, B)` where only `password` differs → assert `delta.set.password` equals B's password and `delta.unset` is empty.
2. **Removed key:** call `buildSnapshotDelta(A, B)` where B lacks a `notes` key present in A → assert `delta.unset` contains `"notes"` and `delta.set` does not.
3. **No change:** call `buildSnapshotDelta(A, A)` → assert `delta.set` is `{}` and `delta.unset` is `[]`.
4. **Apply round-trip:** `applySnapshotDelta(A, buildSnapshotDelta(A, B))` → deep-equals `B` after normalization (confirms that the serialize/apply pair is lossless for every tracked field).
5. **Null delta:** `applySnapshotDelta(snapshot, null)` → snapshot is returned unchanged (graceful no-op for the HEAD commit which stores no delta).

## How the history edge-case tests work

#### Single-commit history

1. Build a history object containing exactly one commit with a full snapshot.
2. Call `serializeHistoryForStorage(history)` → assert `commits[0].delta` is `undefined` and `head_snapshot` matches the commit's snapshot.
3. Call `parseHistoryJson` on the compact output → assert exactly one commit is returned and its `snapshot` matches the original.

#### 20-commit truncation

1. Build a history with 21 commits (newest first in `commits` array, simulating a chain that just exceeded the cap).
2. Call `serializeHistoryForStorage(history)` → assert `commits.length === 20` and the oldest (21st) commit is absent from the output.

## How the leancrypto WASM tests work

The test runner lives in `src/tests/leancrypto.test.js` and can run standalone (`node src/tests/leancrypto.test.js`) or inside Vitest (via a dual-mode wrapper that calls `main()` in `test()` when `globalThis.test` is defined). SPHINCS fixture data is separated into `src/tests/leancrypto.sphincs-vectors.js`. The suite exercises the WASM library directly through its C API:

- **Ascon-Keccak AEAD:** encrypt/decrypt with known vectors; verifies out-of-place and in-place modes, and that tampered ciphertext is rejected with the correct error code.
- **HMAC-SHA3-224:** one-shot MAC against a known vector.
- **SHA3-512:** oneshot and streaming hash against known vectors.
- **HKDF-SHA256:** oneshot and streaming extract+expand against known vectors.
- **SPHINCS+:** key generation, sign, and verify for all six SHAKE parameter sets.

## Performance and load testing

`perf.test.js` is a standalone Node.js script (not a Vitest test) that generates and inserts encrypted test entries directly into Firestore via the REST API. It reproduces the full app crypto and storage flow in Node: user-master-key verification/setup, doc-key wrapping, compact history serialization, and encrypted `entry_key`/`value` writes.

```bash
node perf.test.js secbits-config.json
```

The script reads a random English word pool from `data/english-words.txt` to build realistic entry payloads. It emits per-entry progress logs (index, versions, payload sizes, elapsed time, ETA) and retries failed Firestore writes with exponential backoff.
