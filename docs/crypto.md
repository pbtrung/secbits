# Crypto

AEAD: Ascon-Keccak-512 via leancrypto WASM. All parameters are 512 bits (64 bytes).

| Parameter      | Size                                |
| -------------- | ------------------------------------ |
| SALT_LEN       | 64 bytes                             |
| ENC_KEY_LEN    | 64 bytes                             |
| ENC_IV_LEN     | 64 bytes                             |
| TAG_LEN        | 64 bytes                             |
| HKDF_OUT_LEN   | 128 bytes (ENC_KEY_LEN + ENC_IV_LEN) |

These sizes are the leancrypto WASM bundle's actual API for this Ascon-Keccak-512 variant and must be confirmed against the bundled `leancrypto.js` API before implementation. A 64 byte key and, especially, a 64 byte nonce/IV are atypical for AEAD generally (standard Ascon parameter sets use 128 or 160 bit keys and a 128 bit nonce; AES-GCM and ChaCha20-Poly1305 use a 96 bit nonce), so a size mismatch here would be a straightforward but silent correctness bug if not checked explicitly. Ascon-Keccak-512 is also not a NIST-standardized construction; using it is a deliberate tradeoff, not a default, given it has had far less public cryptanalysis than AES-GCM, ChaCha20-Poly1305, or standard Ascon.

## Entropy Precondition

Every guarantee in this document, salt uniqueness, IV uniqueness, and by extension confidentiality itself, depends on the WASM RNG being properly seeded before any salt or key is generated. This project has previously hit a real gap here (see `seeded_rng_status()` in the WASM entropy backend, added to fix an underseeded RNG). Before generating any salt, UMK, or `entryKey`, including during the very first `keyStore` bootstrap, the client must confirm the RNG backend reports seeded and refuse to encrypt or generate key material otherwise, not assume it silently.

## Key Hierarchy

```text
root_master_key (config)
  └── HKDF+AEAD → keyStore.umkBlob
        └── HKDF+AEAD → entries.entryKey blob (64 raw random bytes, one per entry)
              ├── HKDF+AEAD → entries.encryptedData
              └── HKDF+AEAD → entryHistory.encryptedSnapshot
```

`root_master_key` lives only in local config; it never touches InstantDB. Each level wraps the key below it with a fresh HKDF+AEAD pass, so rotating `root_master_key` only re encrypts `keyStore.umkBlob`, and rotating a single entry only re encrypts that entry's `entryKey` blob, neither requires touching every row.

## Key Hierarchy Key Derivation

Per blob key derivation via HKDF-SHA3-512:

```text
(encKey || encIv) = HKDF-SHA3-512(ikm=K, salt=randomSalt, length=128)
```

Where `K` is the parent key for the blob type (see Key Hierarchy above):

- `keyStore.umkBlob`: `K = root_master_key`
- `entries.entryKey`: `K = UMK` (decrypted from `keyStore.umkBlob`)
- `entries.encryptedData` and `entryHistory.encryptedSnapshot`: `K = entryKey` (decrypted from `entries.entryKey`)

`randomSalt`: 64 fresh random bytes generated per encryption operation. Output split: first 64 bytes to `encKey`, last 64 bytes to `encIv`.

`root_master_key`: supplied from config JSON, minimum 256 bytes when base64 decoded.

A fresh salt on every encryption makes IV reuse structurally impossible.

## Blob Format

Every encrypted blob:

```text
magic (2) || version (2) || salt (64) || ciphertext (var) || tag (64)
```

| Field      | Size     | Value                                       |
| ---------- | -------- | -------------------------------------------- |
| magic      | 2 bytes  | `0x53 0x42` ("SB")                          |
| version    | 2 bytes  | major · minor (e.g. `0x01 0x00` = v1.0)     |
| salt       | 64 bytes | random per blob HKDF input salt             |
| ciphertext | variable | AEAD encrypted compressed payload bytes     |
| tag        | 64 bytes | authentication tag covering AD + ciphertext |

Minimum valid blob length: 2 + 2 + 64 + 0 + 64 = 132 bytes.

## Version Numbering

Each byte encodes one component (major · minor):

| Version bytes | Meaning              |
| -------------- | -------------------- |
| `0x01 0x00`    | v1.0, current format |

Bump minor for additive changes. Bump major for breaking layout or cipher changes.

## AEAD Additional Data

The AEAD tag covers both the ciphertext and the blob header. Additional data passed to `lc_aead_encrypt` / `lc_aead_decrypt`:

```text
AD = magic (2) || version (2) || salt (64)  ->  68 bytes total
```

Any single bit modification to the magic, version, salt, ciphertext, or tag causes authentication failure before any plaintext is returned.

## Magic Bytes

`SB` encoded as UTF-8: `53 42`. Allows immediate format identification in hex dumps and fast fail rejection of blobs that are not SecBits encrypted objects before any crypto work is attempted.

## Versioning Strategy

Every blob carries its own version field. The decoder reads `version[0]` (major) and dispatches to the appropriate decode path before any crypto work begins. Old and new blob versions can coexist in InstantDB indefinitely; no coordinated rewrite is required at write time.

What each version component signals:

- **Minor bump** (`0x01 0x00` to `0x01 0x01`): additive, backward compatible change. Examples: new optional fields added to the plaintext JSON payload inside the ciphertext; change to Brotli compression parameters. A decoder for v1.0 that encounters a v1.1 blob can still decode it correctly by ignoring unknown fields.
- **Major bump** (`0x01 0x00` to `0x02 0x00`): breaking change. A v1.x decoder must refuse a v2.x blob rather than attempt to decode it. Examples: different cipher or KDF (e.g. upgrade to a post quantum algorithm after NIST standardization); different blob layout (field sizes, field ordering, removal of a field); different magic bytes; different salt or tag sizes.

### Upgrade Handling

When a new format version is deployed, existing blobs remain valid at their original version. The client re encrypts a blob to the current version only when it writes it (lazy upgrade on update). An explicit re encrypt all operation can upgrade the entire vault eagerly: for each entry, decrypt with the old version decoder and re encrypt with the current version encoder.

## Current Version

v1.0 (`0x01 0x00`): magic `SB`, Ascon-Keccak-512 AEAD, HKDF-SHA3-512, 64 byte salt, 64 byte tag, 2+2+64 header.

## Encryption Pipeline

The same pipeline applies to every blob type. The IKM passed to HKDF varies by blob type per the key hierarchy.

**Encrypt (write path):**

1. Serialize the payload (entry JSON, key bytes, etc).
2. Brotli compress the payload bytes (for entry data; raw bytes for key material).
3. Generate 64 random salt bytes.
4. Derive `(encKey, encIv) = HKDF-SHA3-512(ikm=K, salt, length=128)`.
5. Compute `AD = magic || version || salt`.
6. AEAD encrypt payload bytes with AD to get `(ciphertext, tag)`.
7. Concatenate: `magic || version || salt || ciphertext || tag`.
8. Base64 encode and write directly to InstantDB via `db.transact`.

**Decrypt (read path):**

1. Read the base64 encoded blob from InstantDB.
2. Base64 decode to raw bytes.
3. Verify magic bytes (`SB`, `0x53 0x42`); reject immediately if mismatch.
4. Extract version, salt, ciphertext, tag.
5. Recompute `AD = magic || version || salt`.
6. Derive `(encKey, encIv) = HKDF-SHA3-512(ikm=K, salt, length=128)`.
7. AEAD decrypt with AD; authentication failure throws before returning any plaintext.
8. Brotli decompress (for entry data).
9. Parse JSON or use raw bytes.

## Commit Hash

The commit hash is computed in the browser over a canonical snapshot object that excludes the `commitHash` field:

```text
commitHash = hex(SHA-256(canonicalJson(snapshotWithoutCommitHash))).slice(0, 32)  // 32 hex chars, 128 bit truncation
```

`canonicalJson` must be deterministic (stable key ordering, UTF-8, no pretty print). The resulting hash is embedded inside the `encryptedSnapshot` blob as `commitHash`. The `entryHistory` entity has no plaintext commit hash field; it exists only inside the ciphertext. After decrypting a snapshot the client verifies by removing `commitHash`, canonicalizing the remaining object, and recomputing the hash.

## Security Properties

- **Confidentiality**: ciphertext is computationally indistinguishable from random without the root master key.
- **Full blob integrity**: magic, version, salt, and ciphertext are all covered by the AEAD tag via additional data. Any single bit modification anywhere in the blob causes authentication failure; no plaintext is returned.
- **Wrong key detection**: decryption with an incorrect root master key fails at the AEAD tag check.
- **No IV reuse**: fresh salt per encryption makes identical plaintext encryptions produce different ciphertext.
- **Compression safety**: compression is performed before encryption; plaintext remains hidden, but ciphertext length still reveals coarse size metadata.
- **Fast fail on wrong format**: magic byte check rejects non vault blobs before any crypto work begins.

## Key Rotation

**Root master key rotation** — re encrypts only the UMK blob in `keyStore`:

1. Decrypt the `keyStore.umkBlob` row using the current `root_master_key`.
2. Re encrypt the raw UMK bytes with the new `root_master_key` (fresh salt, current format version).
3. Write the updated `keyStore` row directly to InstantDB via `db.transact`.

Entry data and history snapshots are unaffected; their encryption depends on `entryKey`, not `root_master_key`.

**UMK rotation** — re encrypts all `entryKey` blobs:

1. Decrypt the current UMK from `keyStore.umkBlob`.
2. Generate a new UMK (64 random bytes).
3. For each entry: decrypt `entryKey` with the old UMK, re encrypt with the new UMK (fresh salt each). Hold the results in memory; do not write anything yet.
4. Re encrypt the new UMK blob with `root_master_key`. Hold the result in memory; do not write it yet.
5. Write the new `keyStore` row and every re encrypted `entryKey` blob together in a single InstantDB transaction via `db.transact`, so the rotation is all or nothing.

This ordering is required, not incidental: writing the new `keyStore` row separately from, and before, the `entryKey` rewrites would leave the vault in a state where the live UMK no longer matches some entries' still-old-UMK-wrapped `entryKey`, permanently stranding them. Batching every write into one transaction means a failure at any point leaves the old UMK and old `entryKey` blobs fully valid and untouched; the whole rotation can simply be retried from step 1. Entry data and history snapshots are unaffected either way; only `entryKey` blobs and the `keyStore` row change, and only together.
