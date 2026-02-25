# Crypto — SecBits

## Constants

```
SALT_LEN            = 64   (bytes)
USER_MASTER_KEY_LEN = 64
DOC_KEY_LEN         = 64
ENC_KEY_LEN         = 64   (512-bit AEAD key)
ENC_IV_LEN          = 64   (512-bit IV)
TAG_LEN             = 64   (512-bit auth tag)
HKDF_OUT_LEN        = 128  (= ENC_KEY_LEN + ENC_IV_LEN)
MASTER_BLOB_LEN     = 192  (= SALT_LEN + USER_MASTER_KEY_LEN + TAG_LEN)
```

Sharing constants (ML-KEM-1024 + X448):
```
SHARE_PK_LEN = 1624   (ML-KEM-1024 pk 1568 + X448 pk 56)
SHARE_SK_LEN = 3224   (ML-KEM-1024 sk 3168 + X448 sk 56)
SHARE_CT_LEN = 1624   (ML-KEM-1024 ct 1568 + X448 eph pk 56)
SHARE_SS_LEN = 64     (hybrid shared secret)
```

## Key Hierarchy

```
root_master_key (≥256 B, from config)
    └── HKDF-SHA3-512(root_master_key, salt) → encKey+encIv
        └── AEAD-encrypt(user_master_key) → user_master_key blob (192 B, in users table)
            └── user_master_key (64 B, in memory per-invocation)
                └── HKDF-SHA3-512(user_master_key, salt) → encKey+encIv
                    └── AEAD-encrypt(doc_key) → entry_key blob (in entries table)
                        └── doc_key (64 B random, per-entry)
                            └── HKDF-SHA3-512(doc_key, salt) → encKey+encIv
                                └── AEAD-encrypt(brotli(JSON(history))) → value blob
```

## Blob Format

`encryptBytesToBlob(key, plaintext)`:
1. Generate random `salt` (64 B).
2. `HKDF-SHA3-512(key, salt)` → `encKey[64] || encIv[64]`.
3. `Ascon-Keccak-512-AEAD-encrypt(encKey, encIv, plaintext)` → `ciphertext + tag[64]`.
4. Return `salt || ciphertext || tag`.

`decryptBytesFromBlob(key, blob)`:
1. Parse `salt = blob[0..64]`, `ciphertext = blob[64..len-64]`, `tag = blob[len-64..len]`.
2. Re-derive `encKey + encIv`.
3. AEAD-decrypt. On auth failure → `DecryptionFailedAuthentication`.

## User Master Key Blob

192-byte blob in `users.user_master_key`:
- `salt[0..64]` — random HKDF salt
- `enc_umk[64..128]` — AES-encrypted user master key
- `tag[128..192]` — AEAD tag

On wrong root key, `verify_user_master_key_blob` maps `DecryptionFailedAuthentication` → `WrongRootMasterKey`.

## Algorithms

- **HKDF**: SHA3-512 via `lc_hkdf(lc_sha3_512, ...)`
- **AEAD**: Ascon-Keccak-512 via `lc_ak_alloc_taglen(lc_sha3_512, 64, ...)`
- **Commit hash**: SHA-256 (first 12 hex chars), non-security-critical identity hash

## leancrypto FFI Notes

- `lc_init(0)` called once via `Once`.
- AEAD context allocated with `lc_ak_alloc_taglen`, freed with `lc_aead_zero_free` (zeroizes + frees).
- Algorithm type verified after alloc: `lc_aead_ctx_algorithm_type(ctx)` must equal `lc_aead_algorithm_type(lc_ascon_keccak_aead)`.
