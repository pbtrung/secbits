import {
  BLOB_MAGIC,
  BLOB_SALT_LEN,
  BLOB_TAG_LEN,
  BLOB_VERSION,
  buildBlob,
  parseBlob,
} from './blob';

const ENC_KEY_LEN = 64;
const ENC_IV_LEN = 64;
const HKDF_OUT_LEN = ENC_KEY_LEN + ENC_IV_LEN;
const ENTRY_KEY_LEN = 64;
const KEM_LEVEL_1024_CANDIDATES = [1, 1024];

function b64ToBytes(b64) {
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    throw new Error('Invalid base64');
  }
}

export function bytesToB64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function getRandomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

function concat(...arrays) {
  const len = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const arr of arrays) {
    out.set(arr, off);
    off += arr.length;
  }
  return out;
}

let lcPromise = null;
let lcScriptPromise = null;

async function ensureLeancryptoScript() {
  if (typeof document === 'undefined') {
    if (typeof globalThis.leancrypto === 'function') return;
    throw new Error('leancrypto global loader not available');
  }
  if (typeof globalThis.leancrypto === 'function') return;
  if (!lcScriptPromise) {
    lcScriptPromise = new Promise((resolve, reject) => {
      const existing = document.querySelector('script[data-leancrypto="1"]');
      if (existing) {
        existing.addEventListener('load', () => resolve(), { once: true });
        existing.addEventListener('error', () => reject(new Error('Failed to load leancrypto script')), { once: true });
        return;
      }

      const script = document.createElement('script');
      script.src = '/leancrypto/leancrypto.js';
      script.async = true;
      script.dataset.leancrypto = '1';
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Failed to load leancrypto script'));
      document.head.appendChild(script);
    });
  }
  await lcScriptPromise;
  if (typeof globalThis.leancrypto !== 'function') {
    throw new Error('leancrypto global loader not available');
  }
}

async function getLc() {
  if (!lcPromise) {
    lcPromise = ensureLeancryptoScript()
      .then(() => globalThis.leancrypto())
      .then((lib) => {
        lib._lc_init();
        return lib;
      });
  }
  return lcPromise;
}

function resolveHashPtr(lib, sym) {
  return lib.HEAPU32[sym >> 2];
}

function writeBytes(lib, data) {
  const ptr = lib._malloc(data.length);
  lib.HEAPU8.set(data, ptr);
  return ptr;
}

function readBytes(lib, ptr, len) {
  return lib.HEAPU8.slice(ptr, ptr + len);
}

function toHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hkdfSync(lib, keyBytes, salt) {
  const sha3_512_ptr = resolveHashPtr(lib, lib._lc_sha3_512);
  const ikmPtr = writeBytes(lib, keyBytes);
  const saltPtr = writeBytes(lib, salt);
  const okmPtr = lib._malloc(HKDF_OUT_LEN);
  try {
    const rc = lib._lc_hkdf(sha3_512_ptr, ikmPtr, keyBytes.length, saltPtr, salt.length, 0, 0, okmPtr, HKDF_OUT_LEN);
    if (rc !== 0) throw new Error(`hkdf failed: rc=${rc}`);
    const okm = readBytes(lib, okmPtr, HKDF_OUT_LEN);
    return {
      encKey: okm.slice(0, ENC_KEY_LEN),
      encIv: okm.slice(ENC_KEY_LEN),
    };
  } finally {
    lib._free(ikmPtr);
    lib._free(saltPtr);
    lib._free(okmPtr);
  }
}

function akEncrypt(lib, encKey, encIv, plainBytes, ad) {
  const sha3_512_ptr = resolveHashPtr(lib, lib._lc_sha3_512);
  const ctxPtrPtr = lib._malloc(4);
  let ctx = 0;
  try {
    const rc = lib._lc_ak_alloc_taglen(sha3_512_ptr, BLOB_TAG_LEN, ctxPtrPtr);
    if (rc !== 0) throw new Error(`lc_ak_alloc_taglen failed: rc=${rc}`);
    ctx = lib.HEAP32[ctxPtrPtr >> 2];
  } finally {
    lib._free(ctxPtrPtr);
  }

  const keyPtr = writeBytes(lib, encKey);
  const ivPtr = writeBytes(lib, encIv);
  const ptPtr = writeBytes(lib, plainBytes);
  const ctPtr = lib._malloc(plainBytes.length);
  const tagPtr = lib._malloc(BLOB_TAG_LEN);
  const adPtr = ad.length > 0 ? writeBytes(lib, ad) : 0;
  try {
    let rc = lib._lc_aead_setkey(ctx, keyPtr, encKey.length, ivPtr, encIv.length);
    if (rc !== 0) throw new Error(`lc_aead_setkey failed: rc=${rc}`);

    rc = lib._lc_aead_encrypt(ctx, ptPtr, ctPtr, plainBytes.length, adPtr, ad.length, tagPtr, BLOB_TAG_LEN);
    if (rc !== 0) throw new Error(`lc_aead_encrypt failed: rc=${rc}`);

    return {
      ciphertext: readBytes(lib, ctPtr, plainBytes.length),
      tag: readBytes(lib, tagPtr, BLOB_TAG_LEN),
    };
  } finally {
    lib._free(keyPtr);
    lib._free(ivPtr);
    lib._free(ptPtr);
    lib._free(ctPtr);
    lib._free(tagPtr);
    if (adPtr) lib._free(adPtr);
    lib._lc_aead_zero_free(ctx);
  }
}

function akDecrypt(lib, encKey, encIv, ciphertext, tag, ad) {
  const sha3_512_ptr = resolveHashPtr(lib, lib._lc_sha3_512);
  const ctxPtrPtr = lib._malloc(4);
  let ctx = 0;
  try {
    const rc = lib._lc_ak_alloc_taglen(sha3_512_ptr, BLOB_TAG_LEN, ctxPtrPtr);
    if (rc !== 0) throw new Error(`lc_ak_alloc_taglen failed: rc=${rc}`);
    ctx = lib.HEAP32[ctxPtrPtr >> 2];
  } finally {
    lib._free(ctxPtrPtr);
  }

  const keyPtr = writeBytes(lib, encKey);
  const ivPtr = writeBytes(lib, encIv);
  const ctPtr = writeBytes(lib, ciphertext);
  const ptPtr = lib._malloc(ciphertext.length);
  const tagPtr = writeBytes(lib, tag);
  const adPtr = ad.length > 0 ? writeBytes(lib, ad) : 0;
  try {
    let rc = lib._lc_aead_setkey(ctx, keyPtr, encKey.length, ivPtr, encIv.length);
    if (rc !== 0) throw new Error(`lc_aead_setkey failed: rc=${rc}`);

    rc = lib._lc_aead_decrypt(ctx, ctPtr, ptPtr, ciphertext.length, adPtr, ad.length, tagPtr, BLOB_TAG_LEN);
    if (rc !== 0) throw new Error('Invalid encrypted value: authentication failed');

    return readBytes(lib, ptPtr, ciphertext.length);
  } finally {
    lib._free(keyPtr);
    lib._free(ivPtr);
    lib._free(ctPtr);
    lib._free(ptPtr);
    lib._free(tagPtr);
    if (adPtr) lib._free(adPtr);
    lib._lc_aead_zero_free(ctx);
  }
}

/**
 * Validate root_master_key from config: must be base64, decode to >= 256 bytes.
 * Returns decoded bytes or throws.
 */
export function decodeRootMasterKey(rootMasterKeyB64) {
  const bytes = b64ToBytes(rootMasterKeyB64);
  if (bytes.length < 256) {
    throw new Error('root_master_key must be at least 256 bytes when decoded');
  }
  return bytes;
}

export function generateEntryKey() {
  return getRandomBytes(ENTRY_KEY_LEN);
}

function resolveKemSizes(lib) {
  const pkSizeFn = lib._lc_ml_kem_x448_pk_size || lib._lc_kyber_x448_pk_size;
  const skSizeFn = lib._lc_ml_kem_x448_sk_size || lib._lc_kyber_x448_sk_size;
  if (typeof pkSizeFn !== 'function' || typeof skSizeFn !== 'function') {
    throw new Error('leancrypto missing mlkem1024+x448 size APIs');
  }
  for (const level of KEM_LEVEL_1024_CANDIDATES) {
    const pkLen = pkSizeFn(level);
    const skLen = skSizeFn(level);
    if (pkLen > 0 && skLen > 0) return { pkLen, skLen };
  }
  throw new Error('leancrypto missing mlkem1024+x448 parameter set');
}

export async function generateMlkem1024X448KeyPair() {
  const lib = await getLc();
  const keypairFn = lib._lc_ml_kem_1024_x448_keypair || lib._lc_kyber_1024_x448_keypair;
  if (typeof keypairFn !== 'function') {
    throw new Error('leancrypto missing mlkem1024+x448 keypair API');
  }
  const { pkLen, skLen } = resolveKemSizes(lib);
  const pkPtr = lib._malloc(pkLen);
  const skPtr = lib._malloc(skLen);
  try {
    const rc = keypairFn(pkPtr, skPtr);
    if (rc !== 0) throw new Error(`mlkem1024+x448 keypair failed: rc=${rc}`);
    return {
      publicKeyRaw: readBytes(lib, pkPtr, pkLen),
      privateKeyRaw: readBytes(lib, skPtr, skLen),
    };
  } finally {
    lib._free(pkPtr);
    lib._free(skPtr);
  }
}

export async function encryptBlob(keyBytes, plainBytes) {
  if (!(keyBytes instanceof Uint8Array) || !(plainBytes instanceof Uint8Array)) {
    throw new Error('encryptBlob expects byte arrays');
  }
  const lib = await getLc();
  const salt = getRandomBytes(BLOB_SALT_LEN);
  const { encKey, encIv } = hkdfSync(lib, keyBytes, salt);
  const ad = concat(BLOB_MAGIC, BLOB_VERSION, salt);
  const { ciphertext, tag } = akEncrypt(lib, encKey, encIv, plainBytes, ad);
  return buildBlob({ salt, ciphertext, tag });
}

export async function decryptBlob(keyBytes, blobBytes) {
  const { salt, ciphertext, tag, ad } = parseBlob(blobBytes);
  const lib = await getLc();
  const { encKey, encIv } = hkdfSync(lib, keyBytes, salt);
  return akDecrypt(lib, encKey, encIv, ciphertext, tag, ad);
}

// Backward-compatible aliases used by existing app code.
export async function encryptBytesToBlob(keyBytes, plainBytes) {
  return encryptBlob(keyBytes, plainBytes);
}

export async function decryptBlobBytes(keyBytes, blobBytes) {
  return decryptBlob(keyBytes, blobBytes);
}

export async function encryptUMK(rawUmkBytes, rootMasterKeyBytes) {
  return encryptBlob(rootMasterKeyBytes, rawUmkBytes);
}

export async function decryptUMK(umkBlobBytes, rootMasterKeyBytes) {
  const raw = await decryptBlob(rootMasterKeyBytes, umkBlobBytes);
  if (raw.length !== ENTRY_KEY_LEN) throw new Error('Invalid UMK');
  return raw;
}

export async function encryptEntryKey(rawEntryKeyBytes, umkBytes) {
  return encryptBlob(umkBytes, rawEntryKeyBytes);
}

export async function decryptEntryKey(entryKeyBlobBytes, umkBytes) {
  const raw = await decryptBlob(umkBytes, entryKeyBlobBytes);
  if (raw.length !== ENTRY_KEY_LEN) throw new Error('Invalid entry key');
  return raw;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

let brotliPromise = null;
async function getBrotli() {
  if (!brotliPromise) {
    brotliPromise = import('brotli-wasm').then((m) => m.default || m);
  }
  return brotliPromise;
}

export async function compressJson(value) {
  const brotli = await getBrotli();
  const json = textEncoder.encode(JSON.stringify(value));
  return brotli.compress(json);
}

export async function decompressJson(bytes) {
  const brotli = await getBrotli();
  const plain = brotli.decompress(bytes);
  return JSON.parse(textDecoder.decode(plain));
}

export async function encryptEntry(entry, entryKeyBytes) {
  const compressed = await compressJson(entry);
  return encryptBlob(entryKeyBytes, compressed);
}

export async function decryptEntry(entryBlobBytes, entryKeyBytes) {
  const compressed = await decryptBlob(entryKeyBytes, entryBlobBytes);
  return decompressJson(compressed);
}

export async function sha3_256Hex(inputBytes) {
  if (!(inputBytes instanceof Uint8Array)) {
    throw new Error('sha3_256Hex expects byte array');
  }
  const lib = await getLc();
  const hashPtr = resolveHashPtr(lib, lib._lc_sha3_256);
  const inPtr = writeBytes(lib, inputBytes);
  const outLen = 32;
  const outPtr = lib._malloc(outLen);
  try {
    const rc = lib._lc_hash(hashPtr, inPtr, inputBytes.length, outPtr);
    if (rc !== 0) throw new Error(`sha3_256 failed: rc=${rc}`);
    return toHex(readBytes(lib, outPtr, outLen));
  } finally {
    lib._free(inPtr);
    lib._free(outPtr);
  }
}
