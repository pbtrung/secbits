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

## Key Hierarchy

```
root_master_key (config)
  └── HKDF+AEAD → key_store UMK blob
        └── HKDF+AEAD → entries.entry_key blob  (64 raw random bytes, one per entry)
              ├── HKDF+AEAD → entries.encrypted_data
              └── HKDF+AEAD → entry_history.encrypted_snapshot
```

key_store blobs for `emergency` and `own_private` types follow the same HKDF+AEAD pipeline with the appropriate parent key as IKM.

## Key Derivation

Per-blob key derivation via **HKDF-SHA3-512**:

```
(encKey || encIv) = HKDF-SHA3-512(ikm=K, salt=randomSalt, length=128)
```

Where `K` is the parent key for the blob type (see key hierarchy above):
- `key_store` blobs: `K` = root_master_key
- `entries.entry_key` blob: `K` = UMK (decrypted from key_store)
- `entries.encrypted_data` and `entry_history.encrypted_snapshot`: `K` = entry_key (decrypted from entries.entry_key)

- `randomSalt`: 64 fresh random bytes generated per encryption operation.
- Output split: first 64 bytes -> `encKey`, last 64 bytes -> `encIv`.
- `root_master_key`: supplied from config JSON, minimum 256 bytes when base64-decoded.

A fresh salt on every encryption makes IV reuse structurally impossible.

## Blob Format

Every encrypted blob:

```
magic (2) || version (2) || salt (64) || ciphertext (var) || tag (64)
```

| Field | Size | Value |
|-------|------|-------|
| `magic` | 2 bytes | `0x53 0x42` ("SB") |
| `version` | 2 bytes | major · minor (e.g. `0x01 0x00` = v1.0) |
| `salt` | 64 bytes | random per-blob HKDF input salt |
| `ciphertext` | variable | AEAD-encrypted compressed payload bytes |
| `tag` | 64 bytes | authentication tag covering AD + ciphertext |

Minimum valid blob length: `2 + 2 + 64 + 0 + 64 = 132 bytes`.

### Version Numbering

Each byte encodes one component (major · minor):

| Version bytes | Meaning |
|---------------|---------|
| `0x01 0x00` | v1.0 — current format |

Bump **minor** for additive changes. Bump **major** for breaking layout or cipher changes.

### AEAD Additional Data

The AEAD tag covers both the ciphertext and the blob header. Additional data passed to `lc_aead_encrypt` / `lc_aead_decrypt`:

```
AD = magic (2) || version (2) || salt (64)  ->  68 bytes total
```

Any single-bit modification to the magic, version, salt, ciphertext, or tag causes authentication failure before any plaintext is returned.

### Magic Bytes

`SB` encoded as UTF-8: `53 42`. Allows immediate format identification in hex dumps and fast-fail rejection of blobs that are not SecBits encrypted objects before any crypto work is attempted.

## Blob Storage

Blobs are stored as BLOB in rqlite columns (`entry_key` and `encrypted_data` in `entries`, `encrypted_snapshot` in `entry_history`, `encrypted_data` in `key_store`). In the rqlite HTTP API and in Worker API JSON responses, BLOB values are base64-encoded strings. The Worker stores and retrieves them without decrypting them.

## Encryption Pipeline

The same pipeline applies to every blob type. The IKM passed to HKDF varies by blob type per the key hierarchy.

**Encrypt (write path):**
1. Serialize the payload (entry JSON, key bytes, etc.).
2. Brotli-compress the payload bytes (for entry data; raw bytes for key material).
3. Generate 64 random salt bytes.
4. Derive `(encKey, encIv)` = HKDF-SHA3-512(ikm=K, salt, length=128).
5. Compute AD = `magic || version || salt`.
6. AEAD-encrypt payload bytes with AD -> `(ciphertext, tag)`.
7. Concatenate: `magic || version || salt || ciphertext || tag`.
8. Transmit to Worker as base64 in JSON body -> stored as BLOB in rqlite.

**Decrypt (read path):**
1. Receive base64-encoded blob from Worker.
2. Base64-decode to raw bytes.
3. Verify magic bytes (`SB`, `0x53 0x42`); reject immediately if mismatch.
4. Extract version, salt, ciphertext, tag.
5. Recompute AD = `magic || version || salt`.
6. Derive `(encKey, encIv)` = HKDF-SHA3-512(ikm=K, salt, length=128).
7. AEAD-decrypt with AD; authentication failure throws before returning any plaintext.
8. Brotli-decompress (for entry data).
9. Parse JSON or use raw bytes.

## Commit Hash

The commit hash is computed in the browser over the plaintext snapshot JSON before encryption:

```
commitHash = z-base-32(SHA3-256(snapshotJson))  -- 52 characters
```

It is embedded inside the `encrypted_snapshot` blob as a field of the snapshot JSON. The `entry_history` table stores no plaintext commit hash column. After decrypting a snapshot the client can verify the hash by recomputing it over the decrypted JSON.

## Security Properties

- **Confidentiality**: ciphertext is computationally indistinguishable from random without the root master key.
- **Full blob integrity**: magic, version, salt, and ciphertext are all covered by the AEAD tag via additional data. Any single-bit modification anywhere in the blob causes authentication failure; no plaintext is returned.
- **Wrong key detection**: decryption with an incorrect root master key fails at the AEAD tag check.
- **No IV reuse**: fresh salt per encryption makes identical-plaintext encryptions produce different ciphertext.
- **Compression safety**: compression before encryption; compressed size is not observable outside the AEAD envelope.
- **Fast-fail on wrong format**: magic byte check rejects non-vault blobs before any crypto work begins.

## Key Rotation

**Root master key rotation** — re-encrypts only the UMK blob in key_store:

1. Decrypt the `umk` key_store row using the current root_master_key.
2. Re-encrypt the raw UMK bytes with the new root_master_key (fresh salt, current format version).
3. Write the updated `key_store` row via the Worker.

Entry data and history snapshots are unaffected; their encryption depends on entry_key, not root_master_key.

**UMK rotation** — re-encrypts all entry_key blobs:

1. Decrypt the current UMK from key_store.
2. Generate a new UMK (64 random bytes).
3. For each entry: decrypt `entry_key` with the old UMK, re-encrypt with the new UMK (fresh salt each).
4. Re-encrypt the new UMK blob with root_master_key and write the updated key_store row.
5. Write all updated `entry_key` blobs via the Worker.

Entry data and history snapshots are unaffected; only `entry_key` blobs are re-encrypted.
