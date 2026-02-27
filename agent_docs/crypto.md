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

- `rootMasterKey`: supplied from config JSON, minimum 256 bytes.
- `randomSalt`: 64 fresh random bytes generated per encryption operation.
- Output split: first 64 bytes → `encKey`, last 64 bytes → `encIv`.

A fresh salt on every encryption makes IV reuse structurally impossible.

## Blob Format

Every encrypted blob:

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

### Version numbering

Each byte encodes one component (major · minor):

| Version bytes | Meaning |
|---------------|---------|
| `0x01 0x00` | v1.0 — current format |

Bump **minor** for additive changes. Bump **major** for breaking layout or cipher changes.

### AEAD Additional Data

The AEAD tag covers both the ciphertext and the blob header. Additional data passed to `lc_aead_encrypt` / `lc_aead_decrypt`:

```
AD = magic (7) || version (2) || salt (64)  →  73 bytes total
```

Any single-bit modification to the magic, version, salt, ciphertext, or tag causes authentication failure before any plaintext is returned.

### Magic bytes

`SecBits` encoded as UTF-8: `53 65 63 42 69 74 73`. Allows immediate format identification in hex dumps and fast-fail rejection of blobs that are not SecBits vault objects before any crypto work is attempted.

## Vault Persistence Pipeline

**Save (write path):**
1. Serialize active entries (`data`) and deleted entries (`trash`) to export JSON.
2. Brotli-compress the UTF-8 JSON bytes.
3. Generate 64 random salt bytes.
4. Derive `(encKey, encIv)` via HKDF-SHA3-512.
5. Compute AD = `magic || version || salt`.
6. AEAD-encrypt compressed bytes with AD → `(ciphertext, tag)`.
7. Concatenate: `magic || version || salt || ciphertext || tag`.
8. POST binary blob to Worker → R2.

**Load (read path):**
1. Read binary blob from R2 via Worker.
2. Verify magic bytes (`SecBits`); reject immediately if mismatch.
3. Extract version, salt, ciphertext, tag.
4. Recompute AD = `magic || version || salt`.
5. Derive `(encKey, encIv)` via HKDF-SHA3-512 using the stored salt.
6. AEAD-decrypt with AD; authentication failure throws before returning any plaintext.
7. Brotli-decompress.
8. Parse JSON → `data` and `trash` arrays.

## Security Properties

- **Confidentiality**: ciphertext is computationally indistinguishable from random without the root master key.
- **Full blob integrity**: magic, version, salt, and ciphertext are all covered by the AEAD tag via additional data. Any single-bit modification anywhere in the blob causes authentication failure; no plaintext is returned.
- **Wrong key detection**: decryption with an incorrect root master key fails at the AEAD tag check.
- **No IV reuse**: fresh salt per encryption makes identical-plaintext encryptions produce different ciphertext.
- **Compression safety**: compression before encryption; compressed size is not observable outside the AEAD envelope.
- **Fast-fail on wrong format**: magic byte check rejects non-vault blobs before any crypto work begins.

## Root Master Key Rotation

Rotating the root master key re-encrypts the entire vault blob:

1. Read and decrypt vault with the current root master key.
2. Re-encrypt the same plaintext with the new root master key (fresh salt, current format version).
3. Write the new blob to R2.

The old key immediately stops working once the new blob is committed to R2.
