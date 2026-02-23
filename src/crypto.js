const SALT_LEN = 64;
const USER_MASTER_KEY_LEN = 64;
const DOC_KEY_LEN = 64;
const ENC_KEY_LEN = 64;
const ENC_IV_LEN = 64;
const TAG_LEN = 64;
const HKDF_OUT_LEN = ENC_KEY_LEN + ENC_IV_LEN; // 128
const MASTER_BLOB_LEN = SALT_LEN + USER_MASTER_KEY_LEN + TAG_LEN; // 192
const encoder = new TextEncoder();
const decoder = new TextDecoder();
let brotliModulePromise = null;

function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function bytesToB64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function toBytes(value, label = 'value') {
  if (value instanceof Uint8Array) return value;
  if (value && typeof value.toUint8Array === 'function') return value.toUint8Array();
  throw new Error(`${label} must be bytes`);
}

function getRandomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

function concat(...arrays) {
  const len = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
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
      .then(lib => { lib._lc_init(); return lib; });
  }
  return lcPromise;
}

function resolveHashPtr(lib, sym) { return lib.HEAPU32[sym >> 2]; }
function writeBytes(lib, data)    { const p = lib._malloc(data.length); lib.HEAPU8.set(data, p); return p; }
function readBytes(lib, ptr, len) { return lib.HEAPU8.slice(ptr, ptr + len); }

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

function akEncrypt(lib, encKey, encIv, plainBytes) {
  const sha3_512_ptr = resolveHashPtr(lib, lib._lc_sha3_512);
  const ctxPtrPtr = lib._malloc(4);
  let ctx = 0;
  try {
    const rc = lib._lc_ak_alloc_taglen(sha3_512_ptr, TAG_LEN, ctxPtrPtr);
    if (rc !== 0) throw new Error(`lc_ak_alloc_taglen failed: rc=${rc}`);
    ctx = lib.HEAP32[ctxPtrPtr >> 2];
  } finally {
    lib._free(ctxPtrPtr);
  }

  const keyPtr = writeBytes(lib, encKey);
  const ivPtr = writeBytes(lib, encIv);
  const ptPtr = writeBytes(lib, plainBytes);
  const ctPtr = lib._malloc(plainBytes.length);
  const tagPtr = lib._malloc(TAG_LEN);
  try {
    let rc = lib._lc_aead_setkey(ctx, keyPtr, encKey.length, ivPtr, encIv.length);
    if (rc !== 0) throw new Error(`lc_aead_setkey failed: rc=${rc}`);

    rc = lib._lc_aead_encrypt(ctx, ptPtr, ctPtr, plainBytes.length, 0, 0, tagPtr, TAG_LEN);
    if (rc !== 0) throw new Error(`lc_aead_encrypt failed: rc=${rc}`);

    const ciphertext = readBytes(lib, ctPtr, plainBytes.length);
    const tag = readBytes(lib, tagPtr, TAG_LEN);
    return { ciphertext, tag };
  } finally {
    lib._free(keyPtr);
    lib._free(ivPtr);
    lib._free(ptPtr);
    lib._free(ctPtr);
    lib._free(tagPtr);
    lib._lc_aead_zero_free(ctx);
  }
}

function akDecrypt(lib, encKey, encIv, ciphertext, tag) {
  const sha3_512_ptr = resolveHashPtr(lib, lib._lc_sha3_512);
  const ctxPtrPtr = lib._malloc(4);
  let ctx = 0;
  try {
    const rc = lib._lc_ak_alloc_taglen(sha3_512_ptr, TAG_LEN, ctxPtrPtr);
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
  try {
    let rc = lib._lc_aead_setkey(ctx, keyPtr, encKey.length, ivPtr, encIv.length);
    if (rc !== 0) throw new Error(`lc_aead_setkey failed: rc=${rc}`);

    rc = lib._lc_aead_decrypt(ctx, ctPtr, ptPtr, ciphertext.length, 0, 0, tagPtr, TAG_LEN);
    if (rc !== 0) throw new Error('Invalid encrypted value: authentication failed');

    return readBytes(lib, ptPtr, ciphertext.length);
  } finally {
    lib._free(keyPtr);
    lib._free(ivPtr);
    lib._free(ctPtr);
    lib._free(ptPtr);
    lib._free(tagPtr);
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

/**
 * First-time setup: generate random User Master Key (64 bytes), encrypt it with
 * keys derived from the root master key, return the blob to store in D1.
 * Also returns the plaintext User Master Key for session use.
 */
export async function setupUserMasterKey(rootMasterKeyBytes) {
  const lib = await getLc();
  const salt = getRandomBytes(SALT_LEN);
  const { encKey, encIv } = hkdfSync(lib, rootMasterKeyBytes, salt);

  const userMasterKey = getRandomBytes(USER_MASTER_KEY_LEN);
  const { ciphertext: encUserMasterKey, tag } = akEncrypt(lib, encKey, encIv, userMasterKey);

  const blob = concat(salt, encUserMasterKey, tag);
  return {
    userMasterKeyBlob: blob,
    userMasterKey,
  };
}

/**
 * Returning user: verify the root master key against the stored blob,
 * decrypt and return the User Master Key or throw on wrong key.
 */
export async function verifyUserMasterKey(rootMasterKeyBytes, storedUserMasterKey) {
  const blob = toBytes(storedUserMasterKey, 'stored user_master_key');
  if (blob.length !== MASTER_BLOB_LEN) {
    throw new Error('Invalid stored user_master_key data');
  }

  const salt = blob.slice(0, SALT_LEN);
  const encUserMasterKey = blob.slice(SALT_LEN, SALT_LEN + USER_MASTER_KEY_LEN);
  const tag = blob.slice(SALT_LEN + USER_MASTER_KEY_LEN);

  const lib = await getLc();
  const { encKey, encIv } = hkdfSync(lib, rootMasterKeyBytes, salt);

  try {
    return akDecrypt(lib, encKey, encIv, encUserMasterKey, tag);
  } catch {
    throw new Error('Wrong root master key');
  }
}

export async function encryptBytesToBlob(keyBytes, plainBytes) {
  const lib = await getLc();
  const salt = getRandomBytes(SALT_LEN);
  const { encKey, encIv } = hkdfSync(lib, keyBytes, salt);
  const { ciphertext, tag } = akEncrypt(lib, encKey, encIv, plainBytes);
  return concat(salt, ciphertext, tag);
}

export async function decryptBlobBytes(keyBytes, blob) {
  if (blob.length < SALT_LEN + TAG_LEN) {
    throw new Error('Invalid encrypted value');
  }

  const salt = blob.slice(0, SALT_LEN);
  const ciphertext = blob.slice(SALT_LEN, blob.length - TAG_LEN);
  const tag = blob.slice(blob.length - TAG_LEN);

  const lib = await getLc();
  const { encKey, encIv } = hkdfSync(lib, keyBytes, salt);
  return akDecrypt(lib, encKey, encIv, ciphertext, tag);
}

async function getBrotli() {
  if (!brotliModulePromise) {
    brotliModulePromise = import('brotli-wasm').then((m) => m.default);
  }
  return brotliModulePromise;
}

export function generateEntryDocKey() {
  return getRandomBytes(DOC_KEY_LEN);
}

export async function wrapEntryKey(userMasterKey, docKeyBytes) {
  if (!(docKeyBytes instanceof Uint8Array) || docKeyBytes.length !== DOC_KEY_LEN) {
    throw new Error('docKeyBytes must be 64 bytes');
  }
  return encryptBytesToBlob(userMasterKey, docKeyBytes);
}

export async function unwrapEntryKey(userMasterKey, entryKeyBlob) {
  const docKeyBytes = await decryptBlobBytes(userMasterKey, toBytes(entryKeyBlob, 'entry_key'));
  if (docKeyBytes.length !== DOC_KEY_LEN) {
    throw new Error('Invalid decrypted doc key length');
  }
  return docKeyBytes;
}

export async function encryptEntryHistoryWithDocKey(docKeyBytes, history) {
  const brotli = await getBrotli();
  const plain = encoder.encode(JSON.stringify(history));
  const compressed = brotli.compress(plain);
  return encryptBytesToBlob(docKeyBytes, compressed);
}

export async function decryptEntryHistoryWithDocKey(docKeyBytes, encryptedValue) {
  const brotli = await getBrotli();
  const compressed = await decryptBlobBytes(docKeyBytes, toBytes(encryptedValue, 'value'));
  const plain = brotli.decompress(compressed);
  const text = decoder.decode(plain);
  return JSON.parse(text);
}
