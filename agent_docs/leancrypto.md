# leancrypto WASM

leancrypto v1.6.0 compiled to WebAssembly via Emscripten. Used for Ascon-Keccak-512 AEAD, HKDF-SHA3-512, and hybrid sharing key generation (`mlkem1024+x448`).

## Directory layout (`leancrypto/`)

| File | Purpose |
|------|---------|
| `leancrypto.js` | Pre-built Emscripten module (committed artifact) |
| `leancrypto.wasm` | Pre-built WASM binary (committed artifact) |
| `meson.build` | WASM-specific Meson build file — replaces upstream `meson.build` |
| `wasm-cross.ini` | Meson Emscripten cross-compilation config |
| `seeded_rng_wasm.c` | WASM-specific seeded RNG source — must be patched into the leancrypto source tree before building |
| `build-wasm.sh` | `emcc` link script that produces `leancrypto.js` + `leancrypto.wasm` |

## Rebuilding

Only needed when upgrading leancrypto or changing build flags. The committed `leancrypto.js` and `leancrypto.wasm` are ready to use as-is.

### Prerequisites

- Emscripten SDK: `emcc` at `/usr/lib/emscripten/emcc` (override with `EMCC_BIN=...`)
- Meson + Ninja
- Git (to clone the leancrypto source)

### Steps

`build-wasm.sh` is self-contained. From the `secbits/leancrypto/` directory:

```bash
./build-wasm.sh
```

This performs the full build pipeline in one shot:

1. Clones leancrypto v1.6.0 to `/tmp/leancrypto-wasm-build` (skipped if already present)
2. Patches the source tree: replaces `meson.build`, adds `wasm-cross.ini`, places `seeded_rng_wasm.c` at `drng/src/`
3. Runs `meson setup` + `ninja` to produce `build-wasm/libleancrypto.a`
4. Runs `emcc` to link `leancrypto.js` + `leancrypto.wasm` and writes them back to `secbits/leancrypto/`

Environment overrides:

| Variable | Default | Purpose |
|----------|---------|---------|
| `EMCC_BIN` | `/usr/lib/emscripten/emcc` | Path to emcc binary |
| `LC_VERSION` | `v1.6.0` | leancrypto git tag to clone |
| `LC_SRC` | `/tmp/leancrypto-wasm-build` | Clone/build directory |
| `OUT_JS` | `$SB_DIR/leancrypto.js` | Output JS module path |
| `OUT_WASM` | `$SB_DIR/leancrypto.wasm` | Output WASM binary path |

> **Why `drng/src/`?** `seeded_rng_wasm.c` is placed at `drng/src/` in the leancrypto source tree because `emcc` compiles it via `-I drng/src` and the path `drng/src/seeded_rng_wasm.c` relative to the source root.

---

## JavaScript API Reference

> Generated from `leancrypto.js` / `leancrypto.wasm` (leancrypto v1.6.0)

### Known Pitfalls

- Hash symbols like `lib._lc_sha3_256` / `lib._lc_sha3_512` may be pointer-to-pointer in this WASM build. For AEAD alloc APIs, pass the dereferenced pointer: `lib.HEAPU32[lib._lc_sha3_256 >> 2]`.
- In this WASI build, AEAD authentication failure maps to `-9` (`EBADMSG` here), not Linux `-74`.
- This bundle exposes `mlkem1024+x448` with legacy symbol names (`_lc_kyber_1024_x448_keypair`, `_lc_kyber_x448_pk_size`, `_lc_kyber_x448_sk_size`). Application code accepts either legacy `kyber` names or newer `mlkem` names when present.

---

### Module Loading

```js
// Browser
import leancrypto from './leancrypto.js';
const lib = await leancrypto();

// Node.js
const leancrypto = require('./leancrypto.js');
const lib = await leancrypto();
```

---

### Memory Management

All C structs and byte buffers live in WASM linear memory. Allocate, use, and free them manually.

```js
const ptr = lib._malloc(n);
lib.HEAPU8.set(myUint8Array, ptr);
const result = lib.HEAPU8.slice(ptr, ptr + n);
lib._free(ptr);
```

Helper pattern used throughout `src/crypto.js`:

```js
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

### Initialization

Must be called once before any other API when using the static library.

```js
lib._lc_init();
```

---

### AEAD — Ascon-Keccak

```c
// int lc_ak_alloc_taglen(const struct lc_hash *hash, uint8_t taglen, struct lc_aead_ctx **ctx)
// int lc_aead_setkey(ctx, key, keylen, iv, ivlen)
// int lc_aead_encrypt(ctx, pt, ct, datalen, aad, aadlen, tag, taglen)
// int lc_aead_decrypt(ctx, ct, pt, datalen, aad, aadlen, tag, taglen)
// void lc_aead_zero_free(ctx)
```

In this build `lib._lc_sha3_512` is a pointer-to-pointer; dereference before use:

```js
const sha3_512 = lib.HEAPU32[lib._lc_sha3_512 >> 2];
```

Encryption with additional data (AD):

```js
const ctxPtrPtr = lib._malloc(4);
lib._lc_ak_alloc_taglen(sha3_512, TAG_LEN, ctxPtrPtr);
const ctx = lib.HEAP32[ctxPtrPtr >> 2];
lib._free(ctxPtrPtr);

lib._lc_aead_setkey(ctx, keyPtr, keyLen, ivPtr, ivLen);
lib._lc_aead_encrypt(ctx, ptPtr, ctPtr, ptLen, adPtr, adLen, tagPtr, TAG_LEN);
lib._lc_aead_zero_free(ctx);
```

Decryption returns `0` on success, `-9` (`EBADMSG`) on authentication failure.

---

### KDF — HKDF

```c
// int lc_hkdf(const struct lc_hash *hash,
//             const uint8_t *ikm, size_t ikmlen,
//             const uint8_t *salt, size_t saltlen,
//             const uint8_t *info, size_t infolen,
//             uint8_t *okm, size_t okmlen)
```

```js
lib._lc_hkdf(lib._lc_sha3_512, ikmPtr, ikmLen,
             saltPtr, saltLen, 0, 0, okmPtr, okmLen);
```

---

### Hybrid Keypair — MLKEM1024+X448

Current bundle symbol set:

```c
// int lc_kyber_1024_x448_keypair(uint8_t *pk, uint8_t *sk)
// size_t lc_kyber_x448_pk_size(uint32_t level)
// size_t lc_kyber_x448_sk_size(uint32_t level)
```

For `level=1` (1024):
- public key size: 1624 bytes
- private key size: 3224 bytes

---

### Hash (SHA-3)

```c
// int lc_hash(const struct lc_hash *hash, const uint8_t *in, size_t inlen, uint8_t *digest)
```

```js
lib._lc_hash(lib._lc_sha3_512, inPtr, inLen, outPtr);
```

---

### Error Codes

| Value | Meaning |
|-------|---------|
| `0` | Success |
| `-1` | `EPERM` / generic error |
| `-9` | `EBADMSG` — AEAD authentication failure (WASI build) |
| `-14` | `EFAULT` — bad pointer or size |
| `-22` | `EINVAL` — invalid argument |

---

### Type Mapping

| C type | JS (`ccall`/`cwrap`) | Notes |
|--------|----------------------|-------|
| `int` / `unsigned int` / `size_t` | `'number'` | 32-bit in wasm32 |
| `uint64_t` | two `'number'` | lo word, hi word |
| `void *` / `const uint8_t *` / `struct *` | `'number'` | WASM linear memory address |
| `void` | `null` | return type only |
