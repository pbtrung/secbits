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
salt (64 bytes) || ciphertext (variable) || tag (64 bytes)
```

- `salt`: the random per-blob HKDF input salt, stored in plaintext.
- `ciphertext`: AEAD-encrypted compressed payload bytes.
- `tag`: 64-byte authentication tag covering the ciphertext.

Minimum valid blob length: `64 + 0 + 64 = 128 bytes`.

## Vault Persistence Pipeline

**Save (write path):**
1. Serialize all entries to export JSON.
2. Brotli-compress the UTF-8 JSON bytes.
3. Generate 64 random salt bytes.
4. Derive `(encKey, encIv)` via HKDF-SHA3-512.
5. AEAD-encrypt compressed bytes → `(ciphertext, tag)`.
6. Concatenate: `salt || ciphertext || tag`.
7. Base64-encode the blob and POST to Worker → R2.

**Load (read path):**
1. Read base64 blob from R2 via Worker.
2. Decode base64 → bytes.
3. Split: `salt` (first 64), `tag` (last 64), `ciphertext` (middle).
4. Derive `(encKey, encIv)` via HKDF-SHA3-512 using the stored salt.
5. AEAD-decrypt; authentication failure throws before returning any plaintext.
6. Brotli-decompress.
7. Parse JSON → entries array.

## Security Properties

- **Confidentiality**: ciphertext is computationally indistinguishable from random without the root master key.
- **Integrity**: any single-bit modification to ciphertext or tag causes AEAD authentication failure; no plaintext is returned.
- **Wrong key detection**: decryption with an incorrect root master key fails at the AEAD tag check.
- **No IV reuse**: fresh salt per encryption makes identical-plaintext encryptions produce different ciphertext.
- **Compression safety**: compression before encryption; compressed size is not observable outside the AEAD envelope.

## Root Master Key Rotation

Rotating the root master key re-encrypts the entire vault blob:

1. Read and decrypt vault with the current root master key.
2. Re-encrypt the same plaintext with the new root master key (fresh salt).
3. Write the new blob to R2.

The old key immediately stops working once the new blob is committed to R2.
