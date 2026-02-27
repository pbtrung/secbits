# leancrypto WASM

leancrypto v1.6.0 compiled to WebAssembly via Emscripten. Used for Ascon-Keccak-512 AEAD and HKDF-SHA3-512.

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

### Steps

**1. Clone leancrypto v1.6.0 source**

```bash
git clone --branch v1.6.0 --depth 1 https://github.com/smuellerDD/leancrypto.git /tmp/lc
```

**2. Patch the source tree**

The files in `secbits/leancrypto/` must be applied to the leancrypto source before building:

```bash
LC=/tmp/lc
SB=/path/to/secbits/leancrypto

# Replace the upstream meson.build with the WASM-specific one
cp "$SB/meson.build"     "$LC/meson.build"

# Add the Emscripten cross-compilation config
cp "$SB/wasm-cross.ini"  "$LC/wasm-cross.ini"

# Place the WASM RNG source where build-wasm.sh expects it
cp "$SB/seeded_rng_wasm.c" "$LC/drng/src/seeded_rng_wasm.c"

# Copy the link script to the source root so ROOT_DIR resolves correctly
cp "$SB/build-wasm.sh"   "$LC/build-wasm.sh"
chmod +x "$LC/build-wasm.sh"
```

> **Why `drng/src/`?** `build-wasm.sh` passes `-I drng/src` and compiles `drng/src/seeded_rng_wasm.c` relative to `ROOT_DIR` (the directory containing the script). With the script at the leancrypto source root, all paths (`drng/src/`, `internal/api/`, `build-wasm/`) resolve correctly against the source tree.

**3. Build the static library**

```bash
cd /tmp/lc
meson setup build-wasm --cross-file wasm-cross.ini \
  -Ddisable-asm=true -Defi=disabled -Dtests=disabled
ninja -C build-wasm
```

This produces `build-wasm/libleancrypto.a`.

**4. Link to WASM module**

```bash
cd /tmp/lc
OUT_JS=/path/to/secbits/leancrypto/leancrypto.js \
OUT_WASM=/path/to/secbits/leancrypto/leancrypto.wasm \
./build-wasm.sh
```

`build-wasm.sh` respects `EMCC_BIN` if emcc is not at the default path.

---

## JavaScript API Reference

> Generated from `leancrypto.js` / `leancrypto.wasm` (leancrypto v1.6.0)

### Known Pitfalls

- Hash symbols like `lib._lc_sha3_256` / `lib._lc_sha3_512` may be pointer-to-pointer in this WASM build. For AEAD alloc APIs, pass the dereferenced pointer: `lib.HEAPU32[lib._lc_sha3_256 >> 2]`.
- In this WASI build, AEAD authentication failure maps to `-9` (`EBADMSG` here), not Linux `-74`.

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
