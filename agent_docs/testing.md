# Testing

## Running Tests

```bash
npx vitest run       # run all suites once
npx vitest           # watch mode
npx vitest run src/tests/crypto.test.js   # single suite
```

## Coverage Matrix

| Area | File | Tests | What is validated |
|---|---|---|---|
| `encryptBytesToBlob` / `decryptBlobBytes` / `bytesToB64` | `src/tests/crypto.test.js` | 5 | Round-trip correctness, AEAD tag structure, tamper rejection; base64 helper |
| `decodeRootMasterKey` | `src/tests/crypto-root-key.test.js` | 4 | Accepts ≥256 decoded bytes; rejects short keys and invalid base64 |
| `setupUserMasterKey` / `verifyUserMasterKey` | `src/tests/crypto-master-key.test.js` | 4 | 192-byte blob output; round-trip UMK recovery; wrong-key rejection; invalid-blob rejection |
| `wrapEntryKey` / `unwrapEntryKey` | `src/tests/crypto-entry-key.test.js` | 4 | Doc-key wrap/unwrap round-trip; blob size; input length guard; tamper rejection |
| `encryptEntryHistoryWithDocKey` / `decryptEntryHistoryWithDocKey` | `src/tests/crypto-entry-history.test.js` | 2 | Compress+encrypt/decrypt+decompress round-trip; tamper detection |
| `generateTOTPForCounter` / `base32Decode` / `generateTOTP` | `src/tests/totp.test.js` | 11 | RFC 6238 SHA-1 known vectors; base32 decode correctness; live-clock 6-digit output |
| leancrypto WASM primitives | `src/tests/leancrypto.test.js` | 1 suite | Ascon-Keccak AEAD, HMAC-SHA3-224, SHA3-512, HKDF-SHA256, SPHINCS+ vectors |
| `buildExportData` | `src/tests/export-data.test.js` | 1 | Export shape, correct field inclusion |
| History format / `buildSnapshotDelta` / `applySnapshotDelta` | `src/tests/history-format.test.js` | 10 | Compact storage round-trip; delta correctness; single-commit edge case; 20-commit truncation cap |
| User master key lifecycle | `src/tests/key-lifecycle.test.js` | 2 | In-memory key store/clear and zeroization on replace |
| `isHttpUrl` | `src/tests/validation.test.js` | 3 | Accepts http/https URLs; rejects non-http(s) schemes |

## Why These Tests Matter

1. **Encryption correctness**: secrets must decrypt to the exact original bytes with no loss.
2. **Integrity enforcement**: AEAD authentication must reject any tampered blob before returning plaintext.
3. **Interoperability**: TOTP output must match RFC vectors so authenticator codes are reliable.
4. **WASM correctness**: leancrypto primitives verified against known vectors before application code relies on them.
5. **Key hierarchy correctness**: a regression at any layer of root key → UMK → doc key silently locks users out of all data.
6. **Delta correctness**: snapshot deltas are the sole basis for version-history reconstruction; incorrect logic silently corrupts the diff viewer and restore results.
7. **Format edge cases**: single-commit history and the 20-commit cap are invariants that are easy to break during refactors.

## Performance Testing

`perf.test.js` is a standalone Node.js script (not a Vitest suite) that generates and inserts encrypted test entries directly against the Worker API, reproducing the full crypto and storage flow in Node.

```bash
node perf.test.js secbits-config.json
```

Reads `data/english-words.txt` for realistic payloads. Emits per-entry progress logs (index, payload sizes, elapsed, ETA) and retries failed writes with exponential backoff.
