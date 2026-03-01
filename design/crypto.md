# Cryptography

## Algorithms

| Primitive | Algorithm | Implementation |
|-----------|-----------|----------------|
| AEAD | Ascon-Keccak-512 | leancrypto-sys FFI |
| Key derivation | HKDF-SHA3-512 | leancrypto-sys FFI |
| Commit hash | SHA-256 (first 32 hex chars) | sha2 crate |
| TOTP | HMAC-SHA1 | hmac + sha1 crates |

All AEAD parameters are 512 bits (64 bytes). This provides 256-bit post-quantum
security margin: Grover's algorithm halves the effective key length of symmetric
ciphers on a quantum computer, so 512-bit parameters retain 256-bit security.

## Constants

```
MAGIC_LEN             = 2    bytes   (0x53 0x42, "SB")
VERSION_LEN           = 2    bytes   (major || minor, currently 0x01 0x00)
HEADER_LEN            = 4    bytes   (= MAGIC_LEN + VERSION_LEN)
SALT_LEN              = 64   bytes
USER_MASTER_KEY_LEN   = 64   bytes
DOC_KEY_LEN           = 64   bytes
ENC_KEY_LEN           = 64   bytes   (512-bit AEAD key)
ENC_IV_LEN            = 64   bytes   (512-bit IV)
TAG_LEN               = 64   bytes   (512-bit auth tag)
HKDF_OUT_LEN          = 128  bytes   (= ENC_KEY_LEN + ENC_IV_LEN)
MASTER_BLOB_LEN       = 196  bytes   (= HEADER_LEN + SALT_LEN + UMK_LEN + TAG_LEN)
AAD_LEN               = 68   bytes   (= HEADER_LEN + SALT_LEN)
```

## Key Hierarchy

```
root_master_key  (≥256 B raw, base64 in config)
│
├── HKDF-SHA3-512(root_master_key, random_salt) → encKey + encIv
│   └── AEAD-encrypt(user_master_key) → umk_blob
│       stored in: key_store WHERE type='umk' (192 B)
│
└── user_master_key  (64 B, decrypted in memory per session)
    │
    ├── HKDF-SHA3-512(user_master_key, random_salt) → encKey + encIv
    │   └── AEAD-encrypt(doc_key) → entry_key_blob
    │       stored in: entries.entry_key
    │
    └── doc_key  (64 B random, per-entry, decrypted on demand)
        │
        └── HKDF-SHA3-512(doc_key, random_salt) → encKey + encIv
            └── AEAD-encrypt(brotli(JSON(history))) → value_blob
                stored in: entries.value
```

Each level uses a freshly generated random salt. The same plaintext encrypted twice
always produces different ciphertext; IV reuse is structurally impossible.

## Blob Format (version 1.0)

Every blob begins with a 4-byte header consisting of two separate fields:

| Field | Size | Value | Description |
|-------|------|-------|-------------|
| magic | 2 bytes | `SB` (`0x53 0x42`) | SecBits identifier |
| version | 2 bytes | `0x01 0x00` | major=1, minor=0 |

`encryptBytesToBlob(key, plaintext)` produces:

```
magic (2) || version (2) || salt (64) || ciphertext (var) || tag (64)
```

`decryptBytesFromBlob(key, blob)` parses:

```
magic      = blob[0..2]        -- must equal 0x53 0x42; reject otherwise
version    = blob[2..4]        -- major = blob[2], minor = blob[3]
salt       = blob[4..68]
ciphertext = blob[68..len-64]
tag        = blob[len-64..len]
```

Minimum valid blob length: `2 + 2 + 64 + 0 + 64 = 132 bytes`.

### Additional Authenticated Data (AAD)

The AEAD tag covers magic, version, and salt in addition to the ciphertext:

```
AAD = magic (2) || version (2) || salt (64)  =  68 bytes
```

Any modification to the magic, version, or salt bytes causes tag verification
to fail before any plaintext is returned. This makes the full blob tamper-evident
and fast-fails on blobs that are not SecBits vault objects.

### Steps

Encrypt:
1. Generate 64 random salt bytes.
2. Compute `AAD = magic || version || salt`.
3. `HKDF-SHA3-512(ikm=key, salt=salt)` → first 64 bytes = `encKey`, last 64 = `encIv`.
4. `Ascon-Keccak-512-AEAD-encrypt(encKey, encIv, plaintext, AAD)` → `ciphertext || tag`.
5. Return `magic || version || salt || ciphertext || tag`.

Decrypt:
1. Check `blob[0..2] == 0x53 0x42`; return `AppError::InvalidBlobFormat` if not.
2. Read `version = blob[2..4]`; handle unknown versions explicitly.
3. Extract `salt`, `ciphertext`, `tag`.
4. Recompute `AAD = magic || version || salt`.
5. Re-derive `encKey + encIv` via HKDF.
6. `Ascon-Keccak-512-AEAD-decrypt(encKey, encIv, ciphertext, tag, AAD)`.
7. Authentication failure → `AppError::DecryptionFailedAuthentication`.

A wrong root key causes failure at the user master key blob decrypt step →
`AppError::WrongRootMasterKey`.

### Version scheme

Magic (`SB`) is fixed. Version is two independent bytes: `major || minor`.
Bump minor for additive changes; bump major for breaking layout or cipher changes.
An unrecognised major version is rejected; a higher minor version on a known major
may be accepted with a warning. Current version: major=1, minor=0.

## User Master Key Blob

196-byte blob stored in `key_store WHERE type='umk'`:

```
magic[0..2]      0x53 0x42 ("SB")
version[2..4]    0x01 0x00 (major=1, minor=0)
salt[4..68]      random HKDF salt
enc_umk[68..132] AEAD-encrypted 64-byte user master key
tag[132..196]    authentication tag
```

This blob is decrypted once per session unlock. The decrypted user master key lives
in `AppState` for the duration of the session and is zeroed on lock.

## Per-Entry Key Wrapping

Each entry row has two blobs:

**`entries.entry_key`**: encrypted doc key:
```
magic(2) || version(2) || salt(64) || encrypted_doc_key(64) || tag(64)  =  196 bytes
```
Encrypted under the user master key.

**`entries.value`**: encrypted history:
```
magic(2) || version(2) || salt(64) || brotli_ciphertext(var) || tag(64)
```
Encrypted under the entry's doc key. The plaintext is Brotli-compressed history JSON.

## Root Master Key Rotation

Rotation re-encrypts only the 196-byte UMK blob stored in `key_store`. All
per-entry data is untouched.

### Key generation

The frontend calls `generate_root_master_key()` (IPC). The backend generates
256 bytes from the OS CSPRNG (`OsRng`) and returns them base64-encoded. No
random bytes are ever produced in the browser.

### Rotation steps

1. Validate the incoming base64: decode and assert length ≥ 256 bytes;
   return `AppError::InvalidRootMasterKey` otherwise.
2. Decrypt the existing UMK blob from `key_store WHERE type='umk'` using the
   current root master key already held in `AppState`.
3. Generate a fresh 64-byte random salt.
4. `HKDF-SHA3-512(ikm=new_root_master_key, salt=new_salt)` → `encKey + encIv`.
5. `Ascon-Keccak-512-AEAD-encrypt(encKey, encIv, umk, AAD)` → new UMK blob.
6. Write the new blob to `key_store` inside a transaction; update `rotated_at`.
7. Update `AppState` to hold the new root master key for the remainder of the
   session.

### Scope

| Affected | Not affected |
|----------|-------------|
| `key_store` UMK blob (196 bytes) | All `entries.entry_key` blobs |
| `AppState` root master key | All `entries.value` blobs |
| | Per-entry doc keys (never re-keyed) |

The user must update the `root_master_key` field in their TOML config before
the session ends. Failure to do so results in a permanent lockout on next
unlock.

## Brotli Compression

History JSON is compressed with Brotli before encryption. Compression:
- Happens before encryption (encrypted data is random-looking; compressors find no structure).
- Achieves 50 to 70% reduction on typical JSON with repetitive field names.
- Hidden inside the AEAD envelope; compressed size is not observable.

## Sharing: ML-KEM-1024 + X448 Hybrid KEM

Entry sharing uses leancrypto's `lcr_kyber_x448` hybrid KEM.

Constants:
```
SHARE_PK_LEN  = 1624  bytes  (ML-KEM-1024 pk 1568 + X448 pk 56)
SHARE_SK_LEN  = 3224  bytes  (ML-KEM-1024 sk 3168 + X448 sk 56)
SHARE_CT_LEN  = 1624  bytes  (ML-KEM-1024 ct 1568 + X448 eph pk 56)
SHARE_SS_LEN  = 64    bytes  (hybrid shared secret)
```

Both ML-KEM-1024 and X448 must be broken simultaneously to compromise a share.
Each `encapsulate()` call generates a fresh ephemeral X448 scalar → forward secrecy
per share. Only `head_snapshot` is shared; commit history is never sent.

## Commit Hash

`SHA-256(content_json_without_timestamp)`, first 32 hex characters.

Used as a stable identifier for `history` display and `restore_to_commit`. Not used
for authentication or integrity (AEAD handles that). 48 bits of collision resistance
is more than sufficient for a personal vault.

## leancrypto FFI Notes

- `lc_init(0)` called once via `std::sync::Once`.
- AEAD context: `lc_ak_alloc_taglen(lc_sha3_512, 64, ...)`, freed with `lc_aead_zero_free`
  (zeroizes memory before freeing; no key material left on heap).
- Algorithm type verified after alloc: `lc_aead_ctx_algorithm_type(ctx)` must equal
  `lc_aead_algorithm_type(lc_ascon_keccak_aead)`.
- HKDF: `lc_hkdf(lc_sha3_512, ...)`.

## Security Properties

- **Confidentiality**: ciphertext is computationally indistinguishable from random without the key.
- **Integrity**: AEAD tag covers the full ciphertext. Any single-bit modification fails authentication.
- **No IV reuse**: fresh random salt per encryption makes identical-plaintext encryptions produce different ciphertext.
- **Wrong key detection**: AEAD tag check fails on wrong key before any plaintext is returned.
- **Key isolation**: leaking one doc key compromises one entry; other entries retain their own doc keys.
- **Root key rotation**: re-encrypts only the 192-byte user master key blob, not individual entries.
- **Zeroization**: `zeroize` crate used on all key material; leancrypto's `lc_aead_zero_free` clears AEAD context.
