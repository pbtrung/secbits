# Testing

## Test Runner

```bash
npx vitest run      # single run
npx vitest          # watch mode
```

## Test Files

| File | Covers |
|------|--------|
| `crypto.test.js` | `encryptBytesToBlob` / `decryptBlobBytes` round-trip, tamper detection, `bytesToB64` |
| `crypto-root-key.test.js` | `decodeRootMasterKey` validation (length, base64) |
| `leancrypto.test.js` | Raw HKDF and AEAD primitives via leancrypto WASM |
| `totp.test.js` | RFC 6238 TOTP code generation and test vectors |
| `validation.test.js` | URL validation and other input validators |
| `export-data.test.js` | `buildExportData` payload shape |

## Critical Path Coverage

1. **Crypto round-trip**: export JSON → compress → encrypt → decrypt → decompress → parse JSON produces identical output.
2. **Tamper detection**: any modification to ciphertext or AEAD tag causes decryption failure before returning plaintext.
3. **Wrong key rejection**: decryption with an incorrect root master key throws.
4. **First-login empty state**: `POST /vault/read` with no existing R2 object returns `{ exists: false, payload_b64: null }`.
5. **Config validation**: invalid `bucket_name`, `prefix`, or `file_name` values are rejected by the Worker with 400.
6. **Firebase token enforcement**: requests without a valid Bearer token receive 401.

## Regression Priorities

- Login reads vault from R2 via `POST /vault/read`.
- Save writes encrypted vault to R2 via `POST /vault/write`.
- Decryption with wrong root master key fails at the AEAD tag check.
- TOTP codes match RFC 6238 test vectors.
- Config JSON with a `root_master_key` shorter than 256 decoded bytes is rejected at startup.
