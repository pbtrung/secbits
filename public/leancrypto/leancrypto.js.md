# leancrypto.js — JavaScript API Reference

> Generated from `leancrypto.js` / `leancrypto.wasm` (WASM build of leancrypto v1.6.0)

---

## Known Pitfalls

- Hash symbols like `lib._lc_sha3_256` / `lib._lc_sha3_512` may be pointer-to-pointer in this WASM build. For AEAD alloc APIs, pass the dereferenced pointer: `lib.HEAPU32[lib._lc_sha3_256 >> 2]`.
- In this WASI build, AEAD authentication failure maps to `-9` (`EBADMSG` here), not Linux `-74`.

---

## Recommended Emscripten Build

Use this deprecation-free command shape for `leancrypto.js`:

```bash
/usr/lib/emscripten/emcc \
  -O3 \
  -s WASM=1 \
  -s MODULARIZE=1 \
  -s EXPORT_NAME="leancrypto" \
  -s EXPORT_ALL=1 \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","getValue","setValue"]' \
  -s EXPORTED_FUNCTIONS='["_malloc","_free","_lc_init","_lc_ak_alloc_taglen","_lc_aead_setkey","_lc_aead_encrypt","_lc_aead_decrypt","_lc_aead_zero","_lc_aead_zero_free","_lc_sha3_256","_lc_sha3_512"]' \
  -I drng/src \
  -I internal/api \
  drng/src/seeded_rng_wasm.c \
  -Wl,--whole-archive build-wasm/libleancrypto.a -Wl,--no-whole-archive \
  -o leancrypto.js
```

Notes:
- Do not use `-s LINKABLE=1` (deprecated).
- Do not export deprecated runtime methods `allocate` / `ALLOC_NORMAL`.
- Keep `_lc_sha3_256` and `_lc_sha3_512` in `EXPORTED_FUNCTIONS` for Ascon-Keccak tests.

---

## Module Loading

```js
// Browser
import leancrypto from './leancrypto.js';
const lib = await leancrypto();

// Node.js
const leancrypto = require('./leancrypto.js');
const lib = await leancrypto();
```

---

## Memory Management

All C structs and byte buffers live in WASM linear memory. You must allocate,
use, and free them manually.

```js
// Allocate n bytes → returns WASM pointer (number)
const ptr = lib._malloc(n);

// Write a JS Uint8Array into WASM memory
lib.HEAPU8.set(myUint8Array, ptr);

// Read n bytes from WASM memory back to JS
const result = lib.HEAPU8.slice(ptr, ptr + n);

// Write/read a 32-bit int pointer (pointer-to-pointer output params)
lib.HEAP32[ptrToPtr >> 2] = someValue;
const outPtr = lib.HEAP32[outPtrPtr >> 2];

// Free allocated memory
lib._free(ptr);
```

### Helper Utility (recommended pattern)

```js
function withBuf(lib, size, fn) {
  const ptr = lib._malloc(size);
  try { return fn(ptr); }
  finally { lib._free(ptr); }
}

function writeBytes(lib, data) {
  const ptr = lib._malloc(data.length);
  lib.HEAPU8.set(data, ptr);
  return ptr; // caller must free
}

function readBytes(lib, ptr, len) {
  return lib.HEAPU8.slice(ptr, ptr + len);
}
```

---

## Initialization

Must be called once before any other API when using the static library.

```js
// int lc_init(void)  →  0 on success
lib._lc_init();
```

---

## Enum Constants

```js
// lc_kyber_type
const LC_KYBER_UNKNOWN = 0;
const LC_KYBER_1024    = 1;
const LC_KYBER_768     = 2;
const LC_KYBER_512     = 3;

// lc_dilithium_type
const LC_DILITHIUM_UNKNOWN = 0;
const LC_DILITHIUM_87      = 1;
const LC_DILITHIUM_65      = 2;
const LC_DILITHIUM_44      = 3;

// lc_sphincs_type (from lc_sphincs.h)
const LC_SPHINCS_SHAKE_256S = 1;
const LC_SPHINCS_SHAKE_256F = 2;
const LC_SPHINCS_SHAKE_192S = 3;
const LC_SPHINCS_SHAKE_192F = 4;
const LC_SPHINCS_SHAKE_128S = 5;
const LC_SPHINCS_SHAKE_128F = 6;
```

---

## Hash (SHA-3 / SHA-2 / SHAKE)

### One-shot hash

```c
// C signature:
// int lc_hash(const struct lc_hash *hash, const uint8_t *in, size_t inlen,
//             uint8_t *digest);
```

```js
// lc_sha3_256, lc_sha3_512, lc_sha3_384, lc_sha3_224
// lc_sha256, lc_sha512, lc_sha384
// lc_shake_128, lc_shake_256   (XOF: use lc_hash_set_digestsize first)

function sha3_256(lib, data) {
  const DIGEST_LEN = 32;
  const hashImpl = lib._lc_sha3_256;   // pointer to hash vtable
  const inPtr    = writeBytes(lib, data);
  const outPtr   = lib._malloc(DIGEST_LEN);
  try {
    const rc = lib._lc_hash(hashImpl, inPtr, data.length, outPtr);
    if (rc !== 0) throw new Error(`lc_hash failed: ${rc}`);
    return readBytes(lib, outPtr, DIGEST_LEN);
  } finally {
    lib._free(inPtr);
    lib._free(outPtr);
  }
}
```

### Streaming hash (init / update / final)

```c
// int  lc_hash_alloc(const struct lc_hash *hash, struct lc_hash_ctx **ctx)
// int  lc_hash_init(struct lc_hash_ctx *ctx)
// void lc_hash_update(struct lc_hash_ctx *ctx, const uint8_t *in, size_t inlen)
// void lc_hash_final(struct lc_hash_ctx *ctx, uint8_t *digest)
// void lc_hash_zero_free(struct lc_hash_ctx *ctx)
```

```js
function sha3_256_streaming(lib, chunks) {
  const DIGEST_LEN = 32;
  const ctxPtrPtr = lib._malloc(4);   // space for one pointer
  lib._lc_hash_alloc(lib._lc_sha3_256, ctxPtrPtr);
  const ctx = lib.HEAP32[ctxPtrPtr >> 2];
  lib._free(ctxPtrPtr);

  lib._lc_hash_init(ctx);
  for (const chunk of chunks) {
    const p = writeBytes(lib, chunk);
    lib._lc_hash_update(ctx, p, chunk.length);
    lib._free(p);
  }
  const outPtr = lib._malloc(DIGEST_LEN);
  lib._lc_hash_final(ctx, outPtr);
  const digest = readBytes(lib, outPtr, DIGEST_LEN);
  lib._free(outPtr);
  lib._lc_hash_zero_free(ctx);
  return digest;
}
```

---

## HMAC

```c
// int  lc_hmac_alloc(const struct lc_hash *hash, struct lc_hmac_ctx **ctx)
// void lc_hmac_init(struct lc_hmac_ctx *ctx, const uint8_t *key, size_t keylen)
// void lc_hmac_update(struct lc_hmac_ctx *ctx, const uint8_t *in, size_t inlen)
// void lc_hmac_final(struct lc_hmac_ctx *ctx, uint8_t *mac)
// size_t lc_hmac_macsize(struct lc_hmac_ctx *ctx)
// void lc_hmac_zero_free(struct lc_hmac_ctx *ctx)
```

```js
function hmac_sha256(lib, key, data) {
  const ctxPtrPtr = lib._malloc(4);
  lib._lc_hmac_alloc(lib._lc_sha256, ctxPtrPtr);
  const ctx = lib.HEAP32[ctxPtrPtr >> 2];
  lib._free(ctxPtrPtr);

  const keyPtr  = writeBytes(lib, key);
  const dataPtr = writeBytes(lib, data);
  lib._lc_hmac_init(ctx, keyPtr, key.length);
  lib._lc_hmac_update(ctx, dataPtr, data.length);
  lib._free(keyPtr);
  lib._free(dataPtr);

  const macLen = lib._lc_hmac_macsize(ctx);   // 32 for SHA-256
  const macPtr = lib._malloc(macLen);
  lib._lc_hmac_final(ctx, macPtr);
  const mac = readBytes(lib, macPtr, macLen);
  lib._free(macPtr);
  lib._lc_hmac_zero_free(ctx);
  return mac;
}
```

---

## KMAC

```c
// int  lc_kmac_alloc(const struct lc_hash *hash, struct lc_kmac_ctx **ctx)
// void lc_kmac_init(struct lc_kmac_ctx *ctx, const uint8_t *key, size_t keylen,
//                   const uint8_t *custom, size_t customlen)
// void lc_kmac_update(struct lc_kmac_ctx *ctx, const uint8_t *in, size_t inlen)
// void lc_kmac_final(struct lc_kmac_ctx *ctx, uint8_t *mac, size_t maclen)
// void lc_kmac_zero_free(struct lc_kmac_ctx *ctx)
```

```js
function kmac256(lib, key, data, outputLen = 32) {
  const ctxPtrPtr = lib._malloc(4);
  lib._lc_kmac_alloc(lib._lc_sha3_256, ctxPtrPtr);
  const ctx = lib.HEAP32[ctxPtrPtr >> 2];
  lib._free(ctxPtrPtr);

  const keyPtr  = writeBytes(lib, key);
  const dataPtr = writeBytes(lib, data);
  lib._lc_kmac_init(ctx, keyPtr, key.length, 0, 0);  // no customization string
  lib._lc_kmac_update(ctx, dataPtr, data.length);
  lib._free(keyPtr);
  lib._free(dataPtr);

  const outPtr = lib._malloc(outputLen);
  lib._lc_kmac_final(ctx, outPtr, outputLen);
  const mac = readBytes(lib, outPtr, outputLen);
  lib._free(outPtr);
  lib._lc_kmac_zero_free(ctx);
  return mac;
}
```

---

## AEAD — Ascon-Keccak

> AEAD = Authenticated Encryption with Associated Data.
> `lc_ak_alloc` uses SHA3-256 or SHA3-512 as the Keccak permutation.
> Default tag length = 16 bytes.

```c
// int lc_ak_alloc(const struct lc_hash *hash, struct lc_aead_ctx **ctx)
// int lc_ak_alloc_taglen(const struct lc_hash *hash, uint8_t taglen,
//                        struct lc_aead_ctx **ctx)
// int lc_aead_setkey(ctx, key, keylen, iv, ivlen)
// int lc_aead_encrypt(ctx, pt, ct, datalen, aad, aadlen, tag, taglen)
// int lc_aead_decrypt(ctx, ct, pt, datalen, aad, aadlen, tag, taglen)
// void lc_aead_zero_free(ctx)
```

```js
const TAG_LEN = 16;
const EBADMSG = 9; // WASI build in this repo returns -9 on auth failure.

// In this build, lib._lc_sha3_256 / _lc_sha3_512 are pointers-to-pointers.
function hashImplPtr(lib, hashSymbol) {
  return lib.HEAPU32[hashSymbol >> 2];
}

function asconKeccakEncrypt(lib, key, iv, plaintext, aad = new Uint8Array(0)) {
  // Allocate AEAD context
  const ctxPtrPtr = lib._malloc(4);
  let rc = lib._lc_ak_alloc(hashImplPtr(lib, lib._lc_sha3_256), ctxPtrPtr);
  if (rc !== 0) throw new Error(`lc_ak_alloc failed: ${rc}`);
  const ctx = lib.HEAP32[ctxPtrPtr >> 2];
  lib._free(ctxPtrPtr);

  const keyPtr = writeBytes(lib, key);
  const ivPtr  = writeBytes(lib, iv);
  const ptPtr  = writeBytes(lib, plaintext);
  const aadPtr = aad.length ? writeBytes(lib, aad) : 0;
  const ctPtr  = lib._malloc(plaintext.length);
  const tagPtr = lib._malloc(TAG_LEN);

  try {
    rc = lib._lc_aead_setkey(ctx, keyPtr, key.length, ivPtr, iv.length);
    if (rc !== 0) throw new Error(`lc_aead_setkey failed: ${rc}`);

    rc = lib._lc_aead_encrypt(
      ctx, ptPtr, ctPtr, plaintext.length,
      aadPtr, aad.length, tagPtr, TAG_LEN
    );
    if (rc !== 0) throw new Error(`lc_aead_encrypt failed: ${rc}`);

    return {
      ciphertext: readBytes(lib, ctPtr, plaintext.length),
      tag:        readBytes(lib, tagPtr, TAG_LEN),
    };
  } finally {
    lib._free(keyPtr); lib._free(ivPtr); lib._free(ptPtr);
    if (aadPtr) lib._free(aadPtr);
    lib._free(ctPtr); lib._free(tagPtr);
    lib._lc_aead_zero_free(ctx);
  }
}

function asconKeccakDecrypt(lib, key, iv, ciphertext, tag, aad = new Uint8Array(0)) {
  const ctxPtrPtr = lib._malloc(4);
  lib._lc_ak_alloc(hashImplPtr(lib, lib._lc_sha3_256), ctxPtrPtr);
  const ctx = lib.HEAP32[ctxPtrPtr >> 2];
  lib._free(ctxPtrPtr);

  const keyPtr = writeBytes(lib, key);
  const ivPtr  = writeBytes(lib, iv);
  const ctPtr  = writeBytes(lib, ciphertext);
  const tagPtr = writeBytes(lib, tag);
  const aadPtr = aad.length ? writeBytes(lib, aad) : 0;
  const ptPtr  = lib._malloc(ciphertext.length);

  try {
    lib._lc_aead_setkey(ctx, keyPtr, key.length, ivPtr, iv.length);
    const rc = lib._lc_aead_decrypt(
      ctx, ctPtr, ptPtr, ciphertext.length,
      aadPtr, aad.length, tagPtr, tag.length
    );
    if (rc !== 0) throw new Error(`Authentication failed (rc=${rc})`);
    return readBytes(lib, ptPtr, ciphertext.length);
  } finally {
    lib._free(keyPtr); lib._free(ivPtr); lib._free(ctPtr);
    lib._free(tagPtr); if (aadPtr) lib._free(aadPtr); lib._free(ptPtr);
    lib._lc_aead_zero_free(ctx);
  }
}
```

### WASM Notes (important)

- For AEAD allocation in this repo's `leancrypto.wasm`, dereference hash symbols before passing them:
  - `const h = lib.HEAPU32[lib._lc_sha3_256 >> 2]`
  - `lib._lc_ak_alloc(h, ctxPtrPtr)`
- On this WASI build, authentication failure from `lc_aead_decrypt` maps to `-9` (`EBADMSG` here), not Linux's usual `-74`.

### Streaming AEAD

```c
// int  lc_aead_enc_init(ctx, aad, aadlen)
// int  lc_aead_enc_update(ctx, pt, ct, datalen)
// int  lc_aead_enc_final(ctx, tag, taglen)
// int  lc_aead_dec_init(ctx, aad, aadlen)
// int  lc_aead_dec_update(ctx, ct, pt, datalen)
// int  lc_aead_dec_final(ctx, tag, taglen)  →  0=ok, -EBADMSG=auth fail
```

---

## ML-KEM (Kyber) — Key Encapsulation

> `lc_seeded_rng` is the default RNG (pass `0` to use it).

### Key sizes (query at runtime)

```js
// unsigned int lc_kyber_pk_size(lc_kyber_type)
// unsigned int lc_kyber_sk_size(lc_kyber_type)
// unsigned int lc_kyber_ct_size(lc_kyber_type)
// unsigned int lc_kyber_ss_size(lc_kyber_type)

const LC_KYBER_768 = 2;
const pkLen = lib._lc_kyber_pk_size(LC_KYBER_768);  // 1184
const skLen = lib._lc_kyber_sk_size(LC_KYBER_768);  // 2400
const ctLen = lib._lc_kyber_ct_size(LC_KYBER_768);  // 1088
const ssLen = lib._lc_kyber_ss_size(LC_KYBER_768);  // 32
```

### Key generation

```c
// int lc_kyber_keypair(struct lc_kyber_pk *pk, struct lc_kyber_sk *sk,
//                      struct lc_rng_ctx *rng, enum lc_kyber_type type)
```

```js
function kyberKeypair(lib, type = LC_KYBER_768) {
  const pkLen = lib._lc_kyber_pk_size(type);
  const skLen = lib._lc_kyber_sk_size(type);

  // lc_kyber_pk / lc_kyber_sk are structs; the raw key bytes are
  // returned via lc_kyber_pk_ptr / lc_kyber_sk_ptr after generation.
  // Use the versioned API: lc_kyber_768_keypair for direct fixed-size structs.
  const pkPtr = lib._malloc(pkLen + 8);  // +8 for struct header
  const skPtr = lib._malloc(skLen + 8);
  try {
    // Pass 0 as rng_ctx to use the built-in seeded RNG
    const rc = lib._lc_kyber_keypair(pkPtr, skPtr, 0, type);
    if (rc !== 0) throw new Error(`lc_kyber_keypair failed: ${rc}`);

    // Extract raw key bytes via ptr/size helpers
    const pkDataPtr = lib._lc_kyber_pk_ptr(pkPtr);
    const skDataPtr = lib._lc_kyber_sk_ptr(skPtr);
    return {
      pk: readBytes(lib, pkDataPtr, pkLen),
      sk: readBytes(lib, skDataPtr, skLen),
      pkPtr,  // keep alive for encapsulation
      skPtr,
    };
  } catch(e) {
    lib._free(pkPtr); lib._free(skPtr);
    throw e;
  }
}
```

### Encapsulation (sender)

```c
// int lc_kyber_enc(struct lc_kyber_ct *ct, struct lc_kyber_ss *ss,
//                  const struct lc_kyber_pk *pk, struct lc_rng_ctx *rng)
```

```js
function kyberEnc(lib, pkPtr, type = LC_KYBER_768) {
  const ctLen = lib._lc_kyber_ct_size(type);
  const ssLen = lib._lc_kyber_ss_size(type);
  const ctPtr = lib._malloc(ctLen + 8);
  const ssPtr = lib._malloc(ssLen + 8);
  try {
    const rc = lib._lc_kyber_enc(ctPtr, ssPtr, pkPtr, 0);
    if (rc !== 0) throw new Error(`lc_kyber_enc failed: ${rc}`);
    return {
      ct: readBytes(lib, lib._lc_kyber_ct_ptr(ctPtr), ctLen),
      ss: readBytes(lib, lib._lc_kyber_ss_ptr(ssPtr), ssLen),
    };
  } finally {
    lib._free(ctPtr); lib._free(ssPtr);
  }
}
```

### Decapsulation (receiver)

```c
// int lc_kyber_dec(struct lc_kyber_ss *ss, const struct lc_kyber_ct *ct,
//                  const struct lc_kyber_sk *sk)
```

```js
function kyberDec(lib, ctBytes, skPtr, type = LC_KYBER_768) {
  const ctLen = lib._lc_kyber_ct_size(type);
  const ssLen = lib._lc_kyber_ss_size(type);
  const ctPtr = lib._malloc(ctLen + 8);
  const ssPtr = lib._malloc(ssLen + 8);

  // Load raw ciphertext bytes into struct
  lib._lc_kyber_ct_load(ctPtr, writeBytes(lib, ctBytes), ctBytes.length);
  try {
    const rc = lib._lc_kyber_dec(ssPtr, ctPtr, skPtr);
    if (rc !== 0) throw new Error(`lc_kyber_dec failed: ${rc}`);
    return readBytes(lib, lib._lc_kyber_ss_ptr(ssPtr), ssLen);
  } finally {
    lib._free(ctPtr); lib._free(ssPtr);
  }
}
```

---

## ML-DSA (Dilithium) — Digital Signatures

### Key sizes (query at runtime)

```js
// unsigned int lc_dilithium_pk_size(lc_dilithium_type)
// unsigned int lc_dilithium_sk_size(lc_dilithium_type)
// unsigned int lc_dilithium_sig_size(lc_dilithium_type)

const LC_DILITHIUM_65 = 2;
const pkLen  = lib._lc_dilithium_pk_size(LC_DILITHIUM_65);   // 1952
const skLen  = lib._lc_dilithium_sk_size(LC_DILITHIUM_65);   // 4032
const sigLen = lib._lc_dilithium_sig_size(LC_DILITHIUM_65);  // 3309
```

### Key generation

```c
// int lc_dilithium_keypair(struct lc_dilithium_pk *pk,
//                          struct lc_dilithium_sk *sk,
//                          struct lc_rng_ctx *rng,
//                          enum lc_dilithium_type type)
```

```js
function dilithiumKeypair(lib, type = LC_DILITHIUM_65) {
  const pkLen = lib._lc_dilithium_pk_size(type);
  const skLen = lib._lc_dilithium_sk_size(type);
  const pkPtr = lib._malloc(pkLen + 8);
  const skPtr = lib._malloc(skLen + 8);
  const rc = lib._lc_dilithium_keypair(pkPtr, skPtr, 0, type);
  if (rc !== 0) { lib._free(pkPtr); lib._free(skPtr); throw new Error(`rc=${rc}`); }
  return {
    pk: readBytes(lib, lib._lc_dilithium_pk_ptr(pkPtr), pkLen),
    sk: readBytes(lib, lib._lc_dilithium_sk_ptr(skPtr), skLen),
    pkPtr, skPtr,
  };
}
```

### Sign

```c
// int lc_dilithium_sign(struct lc_dilithium_sig *sig,
//                       const uint8_t *msg, size_t msglen,
//                       const struct lc_dilithium_sk *sk,
//                       struct lc_rng_ctx *rng)
```

```js
function dilithiumSign(lib, message, skPtr, type = LC_DILITHIUM_65) {
  const sigLen = lib._lc_dilithium_sig_size(type);
  const sigPtr = lib._malloc(sigLen + 8);
  const msgPtr = writeBytes(lib, message);
  try {
    const rc = lib._lc_dilithium_sign(sigPtr, msgPtr, message.length, skPtr, 0);
    if (rc !== 0) throw new Error(`lc_dilithium_sign failed: ${rc}`);
    return readBytes(lib, lib._lc_dilithium_sig_ptr(sigPtr), sigLen);
  } finally {
    lib._free(sigPtr); lib._free(msgPtr);
  }
}
```

### Verify

```c
// int lc_dilithium_verify(const struct lc_dilithium_sig *sig,
//                         const uint8_t *msg, size_t msglen,
//                         const struct lc_dilithium_pk *pk)
// returns 0 = valid, < 0 = invalid
```

```js
function dilithiumVerify(lib, sigBytes, message, pkPtr, type = LC_DILITHIUM_65) {
  const sigLen = lib._lc_dilithium_sig_size(type);
  const sigPtr = lib._malloc(sigLen + 8);
  const msgPtr = writeBytes(lib, message);
  const rawSigPtr = writeBytes(lib, sigBytes);

  lib._lc_dilithium_sig_load(sigPtr, rawSigPtr, sigBytes.length);
  lib._free(rawSigPtr);

  try {
    const rc = lib._lc_dilithium_verify(sigPtr, msgPtr, message.length, pkPtr);
    return rc === 0;   // true = valid
  } finally {
    lib._free(sigPtr); lib._free(msgPtr);
  }
}
```

### Streaming sign (init / update / final)

```c
// int lc_dilithium_sign_init(struct lc_dilithium_ctx *ctx,
//                             const struct lc_dilithium_sk *sk)
// int lc_dilithium_sign_update(struct lc_dilithium_ctx *ctx,
//                               const uint8_t *msg, size_t msglen)
// int lc_dilithium_sign_final(struct lc_dilithium_sig *sig,
//                              struct lc_dilithium_ctx *ctx,
//                              struct lc_rng_ctx *rng)
// int lc_dilithium_ctx_alloc(struct lc_dilithium_ctx **ctx)
// void lc_dilithium_ctx_zero_free(struct lc_dilithium_ctx *ctx)
```

---

## SLH-DSA (SPHINCS+)

```c
// int lc_sphincs_keypair(struct lc_sphincs_pk *pk, struct lc_sphincs_sk *sk,
//                        struct lc_rng_ctx *rng, enum lc_sphincs_type type)
// int lc_sphincs_sign(struct lc_sphincs_sig *sig,
//                     const uint8_t *msg, size_t msglen,
//                     const struct lc_sphincs_sk *sk,
//                     struct lc_rng_ctx *rng)
// int lc_sphincs_verify(const struct lc_sphincs_sig *sig,
//                       const uint8_t *msg, size_t msglen,
//                       const struct lc_sphincs_pk *pk)
// unsigned int lc_sphincs_pk_size(enum lc_sphincs_type type)
// unsigned int lc_sphincs_sk_size(enum lc_sphincs_type type)
// unsigned int lc_sphincs_sig_size(enum lc_sphincs_type type)
```

Same pattern as Dilithium. Use `lc_sphincs_pk_ptr` / `lc_sphincs_sk_ptr` /
`lc_sphincs_sig_ptr` to get raw byte pointers from struct wrappers.

---

## Curves — X25519 / Ed25519

```c
// int lc_x25519_keypair(struct lc_x25519_pk *pk, struct lc_x25519_sk *sk,
//                       struct lc_rng_ctx *rng)
// int lc_x25519_ss(struct lc_x25519_ss *ss,
//                  const struct lc_x25519_pk *pk,
//                  const struct lc_x25519_sk *sk)

// int lc_ed25519_keypair(struct lc_ed25519_pk *pk, struct lc_ed25519_sk *sk,
//                        struct lc_rng_ctx *rng)
// int lc_ed25519_sign(struct lc_ed25519_sig *sig,
//                     const uint8_t *msg, size_t msglen,
//                     const struct lc_ed25519_sk *sk,
//                     struct lc_rng_ctx *rng)
// int lc_ed25519_verify(const struct lc_ed25519_sig *sig,
//                       const uint8_t *msg, size_t msglen,
//                       const struct lc_ed25519_pk *pk)
```

Key sizes: pk=32, sk=64, ss=32, sig=64 bytes.

---

## KDF

### HKDF

```c
// int lc_hkdf(const struct lc_hash *hash,
//             const uint8_t *ikm, size_t ikmlen,
//             const uint8_t *salt, size_t saltlen,
//             const uint8_t *info, size_t infolen,
//             uint8_t *okm, size_t okmlen)
```

```js
function hkdf(lib, ikm, salt, info, okmLen) {
  const ikmPtr  = writeBytes(lib, ikm);
  const saltPtr = salt.length ? writeBytes(lib, salt) : 0;
  const infoPtr = info.length ? writeBytes(lib, info) : 0;
  const okmPtr  = lib._malloc(okmLen);
  try {
    const rc = lib._lc_hkdf(
      lib._lc_sha256,
      ikmPtr, ikm.length,
      saltPtr, salt.length,
      infoPtr, info.length,
      okmPtr, okmLen
    );
    if (rc !== 0) throw new Error(`lc_hkdf failed: ${rc}`);
    return readBytes(lib, okmPtr, okmLen);
  } finally {
    lib._free(ikmPtr);
    if (saltPtr) lib._free(saltPtr);
    if (infoPtr) lib._free(infoPtr);
    lib._free(okmPtr);
  }
}
```

### PBKDF2

```c
// int lc_pbkdf2(const struct lc_hash *hash,
//               const uint8_t *pw, size_t pwlen,
//               const uint8_t *salt, size_t saltlen,
//               uint64_t count,
//               uint8_t *key, size_t keylen)
```

```js
function pbkdf2(lib, password, salt, iterations, keyLen) {
  const pwPtr   = writeBytes(lib, password);
  const saltPtr = writeBytes(lib, salt);
  const keyPtr  = lib._malloc(keyLen);
  try {
    // count is uint64 — pass as two i32 (lo, hi) via ccall
    const rc = lib.ccall('lc_pbkdf2', 'number',
      ['number','number','number','number','number','number','number','number','number'],
      [lib._lc_sha256, pwPtr, password.length, saltPtr, salt.length,
       iterations, 0,  // lo, hi of uint64
       keyPtr, keyLen]
    );
    if (rc !== 0) throw new Error(`lc_pbkdf2 failed: ${rc}`);
    return readBytes(lib, keyPtr, keyLen);
  } finally {
    lib._free(pwPtr); lib._free(saltPtr); lib._free(keyPtr);
  }
}
```

---

## RNG (seeded DRNG)

```c
// lc_seeded_rng  — pointer to the global seeded RNG context
// int lc_rng_generate(struct lc_rng_ctx *rng, const uint8_t *add, size_t addlen,
//                     uint8_t *out, size_t outlen)
```

```js
function randomBytes(lib, n) {
  const outPtr = lib._malloc(n);
  try {
    const rc = lib._lc_rng_generate(lib._lc_seeded_rng, 0, 0, outPtr, n);
    if (rc !== 0) throw new Error(`lc_rng_generate failed: ${rc}`);
    return readBytes(lib, outPtr, n);
  } finally {
    lib._free(outPtr);
  }
}
```

---

## Type Mapping Reference

| C type           | JS (`ccall`/`cwrap`) | Notes                          |
|------------------|----------------------|--------------------------------|
| `int`            | `'number'`           | returned as JS number          |
| `unsigned int`   | `'number'`           |                                |
| `size_t`         | `'number'`           | 32-bit in wasm32               |
| `uint64_t`       | two `'number'`       | lo word, hi word               |
| `void *`         | `'number'`           | WASM linear memory address     |
| `const uint8_t*` | `'number'`           | pass `_malloc`-ed pointer      |
| `struct * `      | `'number'`           | opaque pointer                 |
| `void`           | `null`               | return type only               |

---

## Error Codes

| Value   | Meaning                    |
|---------|----------------------------|
| `0`     | Success                    |
| `-1`    | `EPERM` / generic error    |
| `-14`   | `EFAULT` (bad pointer/size)|
| `-22`   | `EINVAL` (invalid argument)|
| `-74`   | `EBADMSG` (auth tag fail)  |
