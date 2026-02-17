import { xchacha20 } from '@noble/ciphers/chacha.js';
import { randomBytes } from '@noble/ciphers/utils.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha3_512 } from '@noble/hashes/sha3.js';
import { hmac } from '@noble/hashes/hmac.js';
import brotliPromise from 'brotli-wasm';

const SALT_LEN = 64;
const USER_MASTER_KEY_LEN = 64;
const DOC_KEY_LEN = 64;
const ENC_KEY_LEN = 32;
const ENC_IV_LEN = 24;
const HMAC_KEY_LEN = 64;
const HMAC_LEN = 64;
const HKDF_OUT_LEN = ENC_KEY_LEN + ENC_IV_LEN + HMAC_KEY_LEN; // 120
const MASTER_BLOB_LEN = SALT_LEN + USER_MASTER_KEY_LEN + 64; // 192 (salt + encEntryMasterKey + hmac)
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

function deriveKeys(masterKeyBytes, salt) {
  const derived = hkdf(sha3_512, masterKeyBytes, salt, new Uint8Array(), HKDF_OUT_LEN);
  return {
    encKey: derived.slice(0, ENC_KEY_LEN),
    encIv: derived.slice(ENC_KEY_LEN, ENC_KEY_LEN + ENC_IV_LEN),
    hmacKey: derived.slice(ENC_KEY_LEN + ENC_IV_LEN),
  };
}

function computeHmac(hmacKey, data) {
  return hmac(sha3_512, hmacKey, data);
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

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Validate master_key from config: must be base64, decode to >= 128 bytes.
 * Returns decoded bytes or throws.
 */
export function decodeMasterKey(masterKeyB64) {
  const bytes = b64ToBytes(masterKeyB64);
  if (bytes.length < 128) {
    throw new Error('master_key must be at least 128 bytes when decoded');
  }
  return bytes;
}

/**
 * First-time setup: generate salt, encrypt entry master key, return base64 blob to store.
 * Also returns entry master key for session use.
 */
export function masterKeySetup(masterKeyBytes) {
  const salt = randomBytes(SALT_LEN);
  const { encKey, encIv, hmacKey } = deriveKeys(masterKeyBytes, salt);

  const userMasterKey = randomBytes(USER_MASTER_KEY_LEN);
  const encEntryMasterKey = xchacha20(encKey, encIv, userMasterKey);

  const mac = computeHmac(hmacKey, concat(salt, encEntryMasterKey));
  const blob = concat(salt, encEntryMasterKey, mac);

  return {
    storedValue: bytesToB64(blob),
    userMasterKey,
  };
}

/**
 * Returning user: verify master key against stored blob.
 * Returns decrypted entry master key or throws on wrong key.
 */
export function masterKeyVerify(masterKeyBytes, storedB64) {
  const blob = b64ToBytes(storedB64);
  if (blob.length !== MASTER_BLOB_LEN) {
    throw new Error('Invalid stored master_key data');
  }

  const salt = blob.slice(0, SALT_LEN);
  const encEntryMasterKey = blob.slice(SALT_LEN, SALT_LEN + USER_MASTER_KEY_LEN);
  const storedMac = blob.slice(SALT_LEN + USER_MASTER_KEY_LEN);

  const { encKey, encIv, hmacKey } = deriveKeys(masterKeyBytes, salt);

  const mac = computeHmac(hmacKey, concat(salt, encEntryMasterKey));
  if (!timingSafeEqual(mac, storedMac)) {
    throw new Error('Wrong master key');
  }

  const userMasterKey = xchacha20(encKey, encIv, encEntryMasterKey);
  return userMasterKey;
}

function encryptBytes(keyBytes, plainBytes) {
  const salt = randomBytes(SALT_LEN);
  const { encKey, encIv, hmacKey } = deriveKeys(keyBytes, salt);
  const ciphertext = xchacha20(encKey, encIv, plainBytes);
  const mac = computeHmac(hmacKey, concat(salt, ciphertext));
  return bytesToB64(concat(salt, ciphertext, mac));
}

function decryptBytes(keyBytes, storedB64) {
  const blob = b64ToBytes(storedB64);
  if (blob.length < SALT_LEN + HMAC_LEN) {
    throw new Error('Invalid encrypted value');
  }

  const salt = blob.slice(0, SALT_LEN);
  const ciphertext = blob.slice(SALT_LEN, blob.length - HMAC_LEN);
  const storedMac = blob.slice(blob.length - HMAC_LEN);
  const { encKey, encIv, hmacKey } = deriveKeys(keyBytes, salt);
  const mac = computeHmac(hmacKey, concat(salt, ciphertext));

  if (!timingSafeEqual(mac, storedMac)) {
    throw new Error('Invalid encrypted value MAC');
  }

  return xchacha20(encKey, encIv, ciphertext);
}

async function getBrotli() {
  if (!brotliModulePromise) {
    brotliModulePromise = brotliPromise;
  }
  return brotliModulePromise;
}

export function generateEntryDocKey() {
  return randomBytes(DOC_KEY_LEN);
}

export function wrapEntryDocKey(userMasterKey, docKeyBytes) {
  if (!(docKeyBytes instanceof Uint8Array) || docKeyBytes.length !== DOC_KEY_LEN) {
    throw new Error('docKeyBytes must be 64 bytes');
  }
  return encryptBytes(userMasterKey, docKeyBytes);
}

export function unwrapEntryDocKey(userMasterKey, encKeyB64) {
  const docKeyBytes = decryptBytes(userMasterKey, encKeyB64);
  if (docKeyBytes.length !== DOC_KEY_LEN) {
    throw new Error('Invalid decrypted doc key length');
  }
  return docKeyBytes;
}

export async function encryptEntrySnapshotsWithDocKey(docKeyBytes, snapshots) {
  const brotli = await getBrotli();
  const plain = encoder.encode(JSON.stringify(snapshots));
  const compressed = brotli.compress(plain);
  return encryptBytes(docKeyBytes, compressed);
}

export async function decryptEntrySnapshotsWithDocKey(docKeyBytes, valueB64) {
  const brotli = await getBrotli();
  const compressed = decryptBytes(docKeyBytes, valueB64);
  const plain = brotli.decompress(compressed);
  const text = decoder.decode(plain);
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) {
    throw new Error('Decrypted value is not a JSON array');
  }
  return parsed;
}
