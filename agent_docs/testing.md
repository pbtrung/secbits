# Testing

## Test Runner

```bash
npx vitest run      # single run
npx vitest          # watch mode
```

## Test Files

| File | Covers |
|------|--------|
| `crypto.test.js` | `encryptEntry` / `decryptEntry` round-trip, tamper detection, base64 encode/decode |
| `crypto-root-key.test.js` | `decodeRootMasterKey` validation (length, base64) |
| `leancrypto.test.js` | Raw HKDF and AEAD primitives via leancrypto WASM |
| `totp.test.js` | RFC 6238 TOTP code generation and test vectors |
| `validation.test.js` | URL validation and other input validators |
| `export-data.test.js` | `buildExportData` payload shape (all entries + trash) |
| `commit-hash.test.js` | SHA-256 commit hash computation and 32-hex truncation |

## Critical Path Coverage

1. **Crypto round-trip**: entry JSON -> compress -> encrypt -> decrypt -> decompress -> parse JSON produces identical output.
2. **Tamper detection**: any modification to ciphertext, AEAD tag, salt, or magic bytes causes decryption failure before returning plaintext.
3. **Wrong key rejection**: decryption with an incorrect root master key throws.
4. **First login empty state**: `GET /entries` with a vault_id that has no rows returns an empty array.
5. **Input validation**: invalid `vault_id`, `type`, or malformed base64 `encrypted_data` are rejected by the Worker with 400.
6. **Firebase token enforcement**: requests without a valid Bearer token receive 401.
7. **Trash lifecycle**: delete sets `deleted_at`; restore clears it; purge removes entry and all history rows.
8. **History cap**: after 20 commits, inserting a 21st deletes the oldest commit row.
9. **UUID IDs**: new entries and history commits are created with `crypto.randomUUID()`.
10. **Commit hash**: SHA-256 of plaintext JSON, truncated to 32 hex characters, matches after decrypt.

## Regression Priorities

- Login fetches entries via `GET /entries?vault_id=...`.
- Save creates entry via `POST /entries` or updates via `PUT /entries/:id`.
- Each save appends a history commit row.
- Decryption with wrong root master key fails at the AEAD tag check.
- TOTP codes match RFC 6238 test vectors.
- Config JSON with a `root_master_key` shorter than 256 decoded bytes is rejected at startup.
- rqlite queries use parameterized statements; no SQL injection surface.
- Worker rejects requests without a valid Firebase token before executing any rqlite query.
