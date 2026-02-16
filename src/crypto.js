import { xchacha20 } from '@noble/ciphers/chacha.js';
import { randomBytes } from '@noble/ciphers/utils.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha3_512 } from '@noble/hashes/sha3.js';
import { hmac } from '@noble/hashes/hmac.js';

const SALT_LEN = 64;
const C2_LEN = 64;
const ENC_KEY_LEN = 32;
const ENC_IV_LEN = 24;
const HMAC_KEY_LEN = 64;
const HKDF_OUT_LEN = ENC_KEY_LEN + ENC_IV_LEN + HMAC_KEY_LEN; // 120
const TOTAL_LEN = SALT_LEN + C2_LEN + 64; // 192 (salt + enc_c2 + hmac)

function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToB64(bytes) {
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
 * First-time setup: generate salt, encrypt c2, return base64 blob to store.
 * Also returns decrypted c2 for session use.
 */
export function masterKeySetup(masterKeyBytes) {
  const salt = randomBytes(SALT_LEN);
  const { encKey, encIv, hmacKey } = deriveKeys(masterKeyBytes, salt);

  const c2 = randomBytes(C2_LEN);
  const encC2 = xchacha20(encKey, encIv, c2);

  const mac = computeHmac(hmacKey, concat(salt, encC2));
  const blob = concat(salt, encC2, mac);

  return {
    storedValue: bytesToB64(blob),
    c2,
  };
}

/**
 * Returning user: verify master key against stored blob.
 * Returns decrypted c2 or throws on wrong key.
 */
export function masterKeyVerify(masterKeyBytes, storedB64) {
  const blob = b64ToBytes(storedB64);
  if (blob.length !== TOTAL_LEN) {
    throw new Error('Invalid stored master_key data');
  }

  const salt = blob.slice(0, SALT_LEN);
  const encC2 = blob.slice(SALT_LEN, SALT_LEN + C2_LEN);
  const storedMac = blob.slice(SALT_LEN + C2_LEN);

  const { encKey, encIv, hmacKey } = deriveKeys(masterKeyBytes, salt);

  const mac = computeHmac(hmacKey, concat(salt, encC2));
  if (!timingSafeEqual(mac, storedMac)) {
    throw new Error('Wrong master key');
  }

  const c2 = xchacha20(encKey, encIv, encC2);
  return c2;
}
