# Cryptography

## Cipher

**Ascon-Keccak-512 AEAD** via leancrypto WASM.

All parameters are 512 bits (64 bytes):

| Parameter | Size |
|-----------|------|
| `SALT_LEN` | 64 bytes |
| `ENC_KEY_LEN` | 64 bytes |
| `ENC_IV_LEN` | 64 bytes |
| `TAG_LEN` | 64 bytes |
| `HKDF_OUT_LEN` | 128 bytes (`ENC_KEY_LEN + ENC_IV_LEN`) |

512-bit parameters provide 256-bit post-quantum security margin against Grover's algorithm.

## Key Derivation

Per-blob key derivation via **HKDF-SHA3-512**:

```
(encKey || encIv) = HKDF-SHA3-512(ikm=rootMasterKey, salt=randomSalt, length=128)
```

- `rootMasterKey`: supplied from config JSON, minimum 256 bytes when base64-decoded.
- `randomSalt`: 64 fresh random bytes generated per encryption operation.
- Output split: first 64 bytes -> `encKey`, last 64 bytes -> `encIv`.

A fresh salt on every encryption makes IV reuse structurally impossible.

## Blob Format

Every encrypted blob (per entry, per history commit):

```
magic (7) || version (2) || salt (64) || ciphertext (var) || tag (64)
```

| Field | Size | Value |
|-------|------|-------|
| `magic` | 7 bytes | `0x53 0x65 0x63 0x42 0x69 0x74 0x73` ("SecBits") |
| `version` | 2 bytes | major · minor (e.g. `0x01 0x00` = v1.0) |
| `salt` | 64 bytes | random per-blob HKDF input salt |
| `ciphertext` | variable | AEAD-encrypted compressed payload bytes |
| `tag` | 64 bytes | authentication tag covering AD + ciphertext |

Minimum valid blob length: `7 + 2 + 64 + 0 + 64 = 137 bytes`.

### Version Numbering

Each byte encodes one component (major · minor):

| Version bytes | Meaning |
|---------------|---------|
| `0x01 0x00` | v1.0 — current format |

Bump **minor** for additive changes. Bump **major** for breaking layout or cipher changes.

### AEAD Additional Data

The AEAD tag covers both the ciphertext and the blob header. Additional data passed to `lc_aead_encrypt` / `lc_aead_decrypt`:

```
AD = magic (7) || version (2) || salt (64)  ->  73 bytes total
```

Any single-bit modification to the magic, version, salt, ciphertext, or tag causes authentication failure before any plaintext is returned.

### Magic Bytes

`SecBits` encoded as UTF-8: `53 65 63 42 69 74 73`. Allows immediate format identification in hex dumps and fast-fail rejection of blobs that are not SecBits encrypted objects before any crypto work is attempted.

## Blob Storage

Blobs are base64-encoded and stored as TEXT in rqlite columns (`encrypted_data` in `entries`, `encrypted_snapshot` in `entry_history`). The Worker stores and retrieves them as opaque strings.

## Entry Encryption Pipeline

**Save (write path):**
1. Serialize the entry object to JSON.
2. Brotli-compress the UTF-8 JSON bytes.
3. Generate 64 random salt bytes.
4. Derive `(encKey, encIv)` via HKDF-SHA3-512.
5. Compute AD = `magic || version || salt`.
6. AEAD-encrypt compressed bytes with AD -> `(ciphertext, tag)`.
7. Concatenate: `magic || version || salt || ciphertext || tag`.
8. Base64-encode the blob.
9. POST to Worker -> rqlite.

**Load (read path):**
1. Receive base64 blob from Worker (from rqlite).
2. Base64-decode.
3. Verify magic bytes (`SecBits`); reject immediately if mismatch.
4. Extract version, salt, ciphertext, tag.
5. Recompute AD = `magic || version || salt`.
6. Derive `(encKey, encIv)` via HKDF-SHA3-512 using the stored salt.
7. AEAD-decrypt with AD; authentication failure throws before returning any plaintext.
8. Brotli-decompress.
9. Parse JSON -> entry object.

## Commit Hash

History commit hashes are computed over the plaintext entry JSON (before compression and encryption):

```
commitHash = SHA-256(entryJson)[0..31]  -- first 32 hex characters (128-bit truncation)
```

The hash is computed in the browser before encryption and stored in the `commit_hash` column in plaintext. After decrypting a history snapshot, the client can verify the commit hash by recomputing it over the decrypted JSON.

## Security Properties

- **Confidentiality**: ciphertext is computationally indistinguishable from random without the root master key.
- **Full blob integrity**: magic, version, salt, and ciphertext are all covered by the AEAD tag via additional data. Any single-bit modification anywhere in the blob causes authentication failure; no plaintext is returned.
- **Wrong key detection**: decryption with an incorrect root master key fails at the AEAD tag check.
- **No IV reuse**: fresh salt per encryption makes identical-plaintext encryptions produce different ciphertext.
- **Compression safety**: compression before encryption; compressed size is not observable outside the AEAD envelope.
- **Fast-fail on wrong format**: magic byte check rejects non-vault blobs before any crypto work begins.

## Root Master Key Rotation

Rotating the root master key re-encrypts every entry and every history commit in the vault:

1. Fetch all entry blobs and history commit blobs via the Worker.
2. Decrypt each blob with the current root master key.
3. Re-encrypt each blob with the new root master key (fresh salt each, current format version).
4. Write all updated blobs back to rqlite via the Worker.

The old key immediately stops working once all updated blobs are committed. If the operation is interrupted, blobs encrypted with the old and new keys coexist in rqlite until the rotation is retried.
