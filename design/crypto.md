# Cryptography

## Algorithms

| Primitive | Algorithm | Implementation |
|-----------|-----------|----------------|
| AEAD | Ascon-Keccak-512 | leancrypto-sys FFI |
| Key derivation | HKDF-SHA3-512 | leancrypto-sys FFI |
| Commit hash | SHA-256 (first 12 hex chars) | sha2 crate |
| TOTP | HMAC-SHA1 | hmac + sha1 crates |

All AEAD parameters are 512 bits (64 bytes). This provides 256-bit post-quantum
security margin: Grover's algorithm halves the effective key length of symmetric
ciphers on a quantum computer, so 512-bit parameters retain 256-bit security.

## Constants

```
SALT_LEN              = 64   bytes
USER_MASTER_KEY_LEN   = 64   bytes
DOC_KEY_LEN           = 64   bytes
ENC_KEY_LEN           = 64   bytes   (512-bit AEAD key)
ENC_IV_LEN            = 64   bytes   (512-bit IV)
TAG_LEN               = 64   bytes   (512-bit auth tag)
HKDF_OUT_LEN          = 128  bytes   (= ENC_KEY_LEN + ENC_IV_LEN)
MASTER_BLOB_LEN       = 192  bytes   (= SALT_LEN + UMK_LEN + TAG_LEN)
```

## Key Hierarchy

```
root_master_key  (≥256 B raw, base64 in config)
│
├── HKDF-SHA3-512(root_master_key, random_salt) → encKey + encIv
│   └── AEAD-encrypt(user_master_key) → user_master_key_blob
│       stored in: users.user_master_key (192 B)
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

## Blob Format

`encryptBytesToBlob(key, plaintext)` produces:

```
salt (64) || ciphertext (var) || tag (64)
```

`decryptBytesFromBlob(key, blob)` parses:

```
salt  = blob[0..64]
ciphertext = blob[64..len-64]
tag   = blob[len-64..len]
```

Steps:
1. Generate 64 random salt bytes.
2. `HKDF-SHA3-512(ikm=key, salt=salt)` → first 64 bytes = `encKey`, last 64 = `encIv`.
3. `Ascon-Keccak-512-AEAD-encrypt(encKey, encIv, plaintext)` → `ciphertext || tag`.
4. Return `salt || ciphertext || tag`.

On decryption, authentication failure → `AppError::DecryptionFailedAuthentication`.
A wrong root key causes failure at the user master key blob decrypt step →
`AppError::WrongRootMasterKey`.

## User Master Key Blob

192-byte blob stored in `users.user_master_key`:

```
salt[0..64]      random HKDF salt
enc_umk[64..128] AEAD-encrypted 64-byte user master key
tag[128..192]    authentication tag
```

This blob is decrypted once per session unlock. The decrypted user master key lives
in `AppState` for the duration of the session and is zeroed on lock.

## Per-Entry Key Wrapping

Each entry row has two blobs:

**`entries.entry_key`**: encrypted doc key:
```
salt(64) || encrypted_doc_key(64) || tag(64)  =  192 bytes
```
Encrypted under the user master key.

**`entries.value`**: encrypted history:
```
salt(64) || brotli_ciphertext(var) || tag(64)
```
Encrypted under the entry's doc key. The plaintext is Brotli-compressed history JSON.

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

`SHA-256(content_json_without_timestamp)`, first 12 hex characters.

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
