# Entry Sharing — SecBits

## Overview

Share an entry's current `head_snapshot` with another user using hybrid ML-KEM-1024 + X448 KEM. The recipient imports it as a new independent entry with a fresh commit history. No history is shared.

Implemented via leancrypto's `lc_kyber_x448_1024_*` API (already in leancrypto-sys FFI).

## Key Constants

```
SHARE_PK_LEN = 1624  bytes  (ML-KEM-1024 pk 1568 + X448 pk 56)
SHARE_SK_LEN = 3224  bytes  (ML-KEM-1024 sk 3168 + X448 sk 56)
SHARE_CT_LEN = 1624  bytes  (ML-KEM-1024 ct 1568 + X448 eph pk 56)
SHARE_SS_LEN = 64    bytes  (hybrid shared secret)
```

## Schema Migration 2

```sql
ALTER TABLE users ADD COLUMN share_public_key BLOB;       -- NULL until share-init
ALTER TABLE users ADD COLUMN share_secret_key_enc BLOB;   -- NULL until share-init
PRAGMA user_version = 2;
```

Applied when `PRAGMA user_version = 1`.

## Key Storage

- `share_public_key`: raw `SHARE_PK_LEN` bytes, stored plain (public keys are not secret).
- `share_secret_key_enc`: `encryptBytesToBlob(user_master_key, sk)` — `SALT_LEN + SHARE_SK_LEN + TAG_LEN = 3352` bytes.

## Encapsulation (sender)

1. Load `recipient_pk` (`SHARE_PK_LEN` bytes) from file.
2. `lc_kyber_x448_1024_enc(recipient_pk)` → `(kem_ct[SHARE_CT_LEN], ss[SHARE_SS_LEN])`.
3. `(wrap_enc_key[64], wrap_enc_iv[64]) = HKDF-SHA3-512(ikm=ss, salt=kem_ct[0..64])`.
4. `(enc_key_ct[64], enc_key_tag[64]) = AEAD-encrypt(wrap_enc_key, wrap_enc_iv, doc_key)`.
5. `enc_snapshot = encryptBytesToBlob(doc_key, brotli(JSON(head_snapshot)))`.
6. Assemble payload (see format below).

## Decapsulation (recipient)

1. Decrypt own SK: `sk = decryptBytesFromBlob(user_master_key, share_secret_key_enc)`.
2. `ss = lc_kyber_x448_1024_dec(kem_ct, sk)`. Failure → `ShareDecryptFailed`.
3. Re-derive `(wrap_enc_key, wrap_enc_iv)` same as sender.
4. `doc_key = AEAD-decrypt(wrap_enc_key, wrap_enc_iv, enc_key_ct, enc_key_tag)`. Failure → `ShareDecryptFailed`.
5. `decryptBytesFromBlob(doc_key, enc_snapshot)` → brotli decompress → JSON parse.

## Share Payload Format (`.sbsh`)

All multi-byte integers are big-endian.

```
Offset   Size            Field
0        4               Magic: 0x53425348 ("SBSH")
4        4               Version: 0x00000001
8        2               sender_username_len (uint16)
10       N               sender_username (UTF-8)
10+N     2               recipient_username_len (uint16)
12+N     M               recipient_username (UTF-8)
12+N+M   2               path_hint_len (uint16)
14+N+M   P               path_hint (UTF-8)
14+N+M+P 1624            kem_ciphertext
...      128             enc_doc_key (enc_key_ct[64] || enc_key_tag[64])
...      4               enc_snapshot_len (uint32)
...      enc_snapshot_len enc_snapshot (salt[64] || ciphertext || tag[64])
```

Parse validation:
- Magic must be `0x53425348`, version `0x00000001` → else `InvalidSharePayload`.
- Usernames ≤ 255 bytes, path_hint ≤ 512 bytes.
- `recipient_username` must match active user's `username` → else `ShareNotForThisUser`.

## Commands

- `secbits share-init` — generate keypair, store in user row.
- `secbits share-pubkey [--output <file>]` — export own public key.
- `secbits share <path> --recipient-key <file> [--output <file> | --target <name>]` — encrypt and send.
- `secbits share-receive [--input <file> | --target <name> [--object <key>]] [--save-as <path>]` — receive and import.

## S3 Relay Object Key

`<prefix>shares/<recipient_username>/<timestamp_utc_iso8601>.sbsh`

"Latest" = lexicographically largest key under `<prefix>shares/<recipient_username>/`.
