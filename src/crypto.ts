// Per-entry encrypt/decrypt pipeline: HKDF-SHA3-512 key derivation and
// Ascon-Keccak-512 AEAD via the leancrypto WASM module, plus Brotli
// compression for entry/export payloads. Everything above encryptBlob/
// decryptBlob is WASM plumbing (loading the module, marshaling bytes across
// the JS/WASM boundary); everything below is the actual key hierarchy
// (UMK, entry keys, entries) built on top of it. See docs/crypto.md for the
// cipher spec, key hierarchy, and blob format this file implements.
import { BLOB_MAGIC, BLOB_SALT_LEN, BLOB_TAG_LEN, BLOB_VERSION, buildBlob, parseBlob } from './lib/blob';
import type { BrotliWasmType } from 'brotli-wasm';

const ENC_KEY_LEN = 64;
const ENC_IV_LEN = 64;
const HKDF_OUT_LEN = ENC_KEY_LEN + ENC_IV_LEN;
const ENTRY_KEY_LEN = 64;

// Minimal typing of the leancrypto Emscripten WASM module: only the members
// this file actually touches, not a full binding-generation effort. Numeric
// fields like `_lc_sha3_512` are exported C global addresses (a pointer to
// a hash algorithm descriptor), not functions; the `_lc_*` methods are
// exported C functions operating on WASM linear memory pointers (numbers).
export interface LeancryptoModule {
  _lc_init(): void;
  _malloc(size: number): number;
  _free(ptr: number): void;
  _lc_sha3_512: number;
  _lc_sha3_256: number;
  _lc_hkdf(
    hashPtr: number,
    ikmPtr: number,
    ikmLen: number,
    saltPtr: number,
    saltLen: number,
    infoPtr: number,
    infoLen: number,
    okmPtr: number,
    okmLen: number,
  ): number;
  _lc_ak_alloc_taglen(hashPtr: number, tagLen: number, ctxPtrPtr: number): number;
  _lc_aead_setkey(ctx: number, keyPtr: number, keyLen: number, ivPtr: number, ivLen: number): number;
  _lc_aead_encrypt(
    ctx: number,
    ptPtr: number,
    ctPtr: number,
    ptLen: number,
    adPtr: number,
    adLen: number,
    tagPtr: number,
    tagLen: number,
  ): number;
  _lc_aead_decrypt(
    ctx: number,
    ctPtr: number,
    ptPtr: number,
    ctLen: number,
    adPtr: number,
    adLen: number,
    tagPtr: number,
    tagLen: number,
  ): number;
  _lc_aead_zero_free(ctx: number): void;
  _lc_hash(hashPtr: number, inPtr: number, inLen: number, outPtr: number): number;
  HEAPU8: Uint8Array;
  HEAPU32: Uint32Array;
  HEAP32: Int32Array;
}

declare global {
  // eslint-disable-next-line no-var
  var leancrypto: (() => Promise<LeancryptoModule>) | undefined;
}

export function b64ToBytes(b64: string): Uint8Array {
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    throw new Error('Invalid base64');
  }
}

export function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function getRandomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const len = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const arr of arrays) {
    out.set(arr, off);
    off += arr.length;
  }
  return out;
}

let lcPromise: Promise<LeancryptoModule> | null = null;
let lcScriptPromise: Promise<void> | null = null;

function loadLeancryptoScript(): Promise<void> {
  return new Promise((resolve, reject) => {
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

async function ensureLeancryptoScript(): Promise<void> {
  if (typeof globalThis.leancrypto === 'function') return;
  if (typeof document === 'undefined') {
    throw new Error('leancrypto global loader not available');
  }
  lcScriptPromise ??= loadLeancryptoScript();
  await lcScriptPromise;
  if (typeof globalThis.leancrypto !== 'function') {
    throw new Error('leancrypto global loader not available');
  }
}

async function getLc(): Promise<LeancryptoModule> {
  if (!lcPromise) {
    lcPromise = ensureLeancryptoScript()
      .then(() => globalThis.leancrypto!())
      .then((lib) => {
        lib._lc_init();
        return lib;
      });
  }
  return lcPromise;
}

// `_lc_sha3_512`/`_lc_sha3_256` are addresses of C globals holding a
// `struct lc_hash *` (a pointer value), not the descriptor itself, so the
// pointer they hold has to be read out of WASM memory before use. `HEAPU32`
// indexes 4 byte words, hence `>> 2` to convert a byte address into a word
// index.
function resolveHashPtr(lib: LeancryptoModule, sym: number): number {
  return lib.HEAPU32[sym >> 2];
}

// Every AEAD/HKDF/hash call below needs its inputs sitting in WASM linear
// memory first, since the exported `_lc_*` functions only take pointers
// (numbers), never JS arrays. Callers are responsible for freeing the
// returned pointer once the WASM call using it has returned.
function writeBytes(lib: LeancryptoModule, data: Uint8Array): number {
  const ptr = lib._malloc(data.length);
  lib.HEAPU8.set(data, ptr);
  return ptr;
}

// Copies `len` bytes out of WASM memory starting at `ptr` into a fresh,
// GC-managed Uint8Array; the result stays valid after the source pointer is
// freed (unlike a `subarray`, which would alias freed/reused WASM memory).
function readBytes(lib: LeancryptoModule, ptr: number, len: number): Uint8Array {
  return lib.HEAPU8.slice(ptr, ptr + len);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

interface HkdfKeyIv {
  encKey: Uint8Array;
  encIv: Uint8Array;
}

function deriveHkdfKeyIv(
  lib: LeancryptoModule,
  hashPtr: number,
  ikmPtr: number,
  ikmLen: number,
  saltPtr: number,
  saltLen: number,
  okmPtr: number,
): HkdfKeyIv {
  const rc = lib._lc_hkdf(hashPtr, ikmPtr, ikmLen, saltPtr, saltLen, 0, 0, okmPtr, HKDF_OUT_LEN);
  if (rc !== 0) throw new Error(`hkdf failed: rc=${rc}`);
  const okm = readBytes(lib, okmPtr, HKDF_OUT_LEN);
  return { encKey: okm.slice(0, ENC_KEY_LEN), encIv: okm.slice(ENC_KEY_LEN) };
}

// Derives one HKDF-SHA3-512 output of HKDF_OUT_LEN bytes and splits it into
// the AEAD key (first ENC_KEY_LEN bytes) and IV (remainder) — one HKDF call
// covers both, rather than deriving them separately, since they're really
// one expanded output split by convention (see docs/crypto.md, Key
// Hierarchy). No `info` parameter is used (passed as a null 0 length
// pointer): the salt alone is enough to keep every call's expansion unique.
function hkdfSync(lib: LeancryptoModule, keyBytes: Uint8Array, salt: Uint8Array): HkdfKeyIv {
  const hashPtr = resolveHashPtr(lib, lib._lc_sha3_512);
  const ikmPtr = writeBytes(lib, keyBytes);
  const saltPtr = writeBytes(lib, salt);
  const okmPtr = lib._malloc(HKDF_OUT_LEN);
  try {
    return deriveHkdfKeyIv(lib, hashPtr, ikmPtr, keyBytes.length, saltPtr, salt.length, okmPtr);
  } finally {
    lib._free(ikmPtr);
    lib._free(saltPtr);
    lib._free(okmPtr);
  }
}

// Shared by akEncrypt/akDecrypt: both need an AEAD context sized for the
// same tag length, allocated the same way.
//
// `_lc_ak_alloc_taglen` follows the C convention of returning its allocated
// context via an out-parameter: `ctxPtrPtr` is a pointer to a 4 byte slot
// that the call fills in with the context's own address, so it has to be
// read back out of `HEAP32` (word-indexed, hence `>> 2`) after the call
// succeeds. `ctxPtrPtr` itself is just scratch space for that handoff and is
// freed here; the context address it yielded is owned by the caller, freed
// via `_lc_aead_zero_free` once encryption/decryption is done with it.
function allocAeadCtx(lib: LeancryptoModule): number {
  const sha3_512_ptr = resolveHashPtr(lib, lib._lc_sha3_512);
  const ctxPtrPtr = lib._malloc(4);
  try {
    const rc = lib._lc_ak_alloc_taglen(sha3_512_ptr, BLOB_TAG_LEN, ctxPtrPtr);
    if (rc !== 0) throw new Error(`lc_ak_alloc_taglen failed: rc=${rc}`);
    return lib.HEAP32[ctxPtrPtr >> 2];
  } finally {
    lib._free(ctxPtrPtr);
  }
}

interface AeadEncryptPtrs {
  keyPtr: number;
  ivPtr: number;
  ptPtr: number;
  ctPtr: number;
  tagPtr: number;
  adPtr: number;
}

interface AeadResult {
  ciphertext: Uint8Array;
  tag: Uint8Array;
}

function runAeadEncrypt(
  lib: LeancryptoModule,
  ctx: number,
  ptrs: AeadEncryptPtrs,
  keyLen: number,
  ivLen: number,
  ptLen: number,
  adLen: number,
): AeadResult {
  let rc = lib._lc_aead_setkey(ctx, ptrs.keyPtr, keyLen, ptrs.ivPtr, ivLen);
  if (rc !== 0) throw new Error(`lc_aead_setkey failed: rc=${rc}`);

  rc = lib._lc_aead_encrypt(ctx, ptrs.ptPtr, ptrs.ctPtr, ptLen, ptrs.adPtr, adLen, ptrs.tagPtr, BLOB_TAG_LEN);
  if (rc !== 0) throw new Error(`lc_aead_encrypt failed: rc=${rc}`);

  return {
    ciphertext: readBytes(lib, ptrs.ctPtr, ptLen),
    tag: readBytes(lib, ptrs.tagPtr, BLOB_TAG_LEN),
  };
}

// `adPtr` is left as the null pointer (0) when there's no associated data:
// leancrypto accepts a null AD pointer paired with `adLen: 0` as "no AD",
// and skipping the allocation avoids a pointless malloc/free of a 0 byte
// buffer (also why the `if (adPtr)` guard below only frees it when set).
function akEncrypt(
  lib: LeancryptoModule,
  encKey: Uint8Array,
  encIv: Uint8Array,
  plainBytes: Uint8Array,
  ad: Uint8Array,
): AeadResult {
  const ctx = allocAeadCtx(lib);
  const keyPtr = writeBytes(lib, encKey);
  const ivPtr = writeBytes(lib, encIv);
  const ptPtr = writeBytes(lib, plainBytes);
  const ctPtr = lib._malloc(plainBytes.length);
  const tagPtr = lib._malloc(BLOB_TAG_LEN);
  const adPtr = ad.length > 0 ? writeBytes(lib, ad) : 0;
  try {
    return runAeadEncrypt(
      lib,
      ctx,
      { keyPtr, ivPtr, ptPtr, ctPtr, tagPtr, adPtr },
      encKey.length,
      encIv.length,
      plainBytes.length,
      ad.length,
    );
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

interface AeadDecryptPtrs {
  keyPtr: number;
  ivPtr: number;
  ctPtr: number;
  ptPtr: number;
  tagPtr: number;
  adPtr: number;
}

function runAeadDecrypt(
  lib: LeancryptoModule,
  ctx: number,
  ptrs: AeadDecryptPtrs,
  keyLen: number,
  ivLen: number,
  ctLen: number,
  adLen: number,
): Uint8Array {
  let rc = lib._lc_aead_setkey(ctx, ptrs.keyPtr, keyLen, ptrs.ivPtr, ivLen);
  if (rc !== 0) throw new Error(`lc_aead_setkey failed: rc=${rc}`);

  rc = lib._lc_aead_decrypt(ctx, ptrs.ctPtr, ptrs.ptPtr, ctLen, ptrs.adPtr, adLen, ptrs.tagPtr, BLOB_TAG_LEN);
  if (rc !== 0) throw new Error('Invalid encrypted value: authentication failed');

  return readBytes(lib, ptrs.ptPtr, ctLen);
}

function akDecrypt(
  lib: LeancryptoModule,
  encKey: Uint8Array,
  encIv: Uint8Array,
  ciphertext: Uint8Array,
  tag: Uint8Array,
  ad: Uint8Array,
): Uint8Array {
  const ctx = allocAeadCtx(lib);
  const keyPtr = writeBytes(lib, encKey);
  const ivPtr = writeBytes(lib, encIv);
  const ctPtr = writeBytes(lib, ciphertext);
  const ptPtr = lib._malloc(ciphertext.length);
  const tagPtr = writeBytes(lib, tag);
  const adPtr = ad.length > 0 ? writeBytes(lib, ad) : 0;
  try {
    return runAeadDecrypt(
      lib,
      ctx,
      { keyPtr, ivPtr, ctPtr, ptPtr, tagPtr, adPtr },
      encKey.length,
      encIv.length,
      ciphertext.length,
      ad.length,
    );
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
 * Validate a master key from config: must be base64, decode to >= 256 bytes.
 * Shared by root_master_key and backup_master_key, which have identical
 * format requirements. Returns decoded bytes or throws.
 */
function decodeMasterKey(masterKeyB64: string, label: string): Uint8Array {
  const bytes = b64ToBytes(masterKeyB64);
  if (bytes.length < 256) {
    throw new Error(`${label} must be at least 256 bytes when decoded`);
  }
  return bytes;
}

export function decodeRootMasterKey(rootMasterKeyB64: string): Uint8Array {
  return decodeMasterKey(rootMasterKeyB64, 'Root master key');
}

// backup_master_key is a config only secret, independent of root_master_key:
// it never touches InstantDB in any form, wrapped or not, so a cloud backup
// stays decryptable using only the config file even if InstantDB itself is
// completely lost. See docs/crypto.md, Cloud Backup.
export function decodeBackupMasterKey(backupMasterKeyB64: string): Uint8Array {
  return decodeMasterKey(backupMasterKeyB64, 'Backup master key');
}

export function generateEntryKey(): Uint8Array {
  return getRandomBytes(ENTRY_KEY_LEN);
}

export function generateUMK(): Uint8Array {
  return getRandomBytes(ENTRY_KEY_LEN);
}

export async function encryptBlob(keyBytes: Uint8Array, plainBytes: Uint8Array): Promise<Uint8Array> {
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

export async function decryptBlob(keyBytes: Uint8Array, blobBytes: Uint8Array): Promise<Uint8Array> {
  const { salt, ciphertext, tag, ad } = parseBlob(blobBytes);
  const lib = await getLc();
  const { encKey, encIv } = hkdfSync(lib, keyBytes, salt);
  return akDecrypt(lib, encKey, encIv, ciphertext, tag, ad);
}

export async function encryptUMK(rawUmkBytes: Uint8Array, rootMasterKeyBytes: Uint8Array): Promise<Uint8Array> {
  return encryptBlob(rootMasterKeyBytes, rawUmkBytes);
}

export async function decryptUMK(umkBlobBytes: Uint8Array, rootMasterKeyBytes: Uint8Array): Promise<Uint8Array> {
  const raw = await decryptBlob(rootMasterKeyBytes, umkBlobBytes);
  if (raw.length !== ENTRY_KEY_LEN) throw new Error('Invalid UMK');
  return raw;
}

export async function encryptEntryKey(rawEntryKeyBytes: Uint8Array, umkBytes: Uint8Array): Promise<Uint8Array> {
  return encryptBlob(umkBytes, rawEntryKeyBytes);
}

export async function decryptEntryKey(entryKeyBlobBytes: Uint8Array, umkBytes: Uint8Array): Promise<Uint8Array> {
  const raw = await decryptBlob(umkBytes, entryKeyBlobBytes);
  if (raw.length !== ENTRY_KEY_LEN) throw new Error('Invalid entry key');
  return raw;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

let brotliPromise: Promise<BrotliWasmType> | null = null;
async function getBrotli(): Promise<BrotliWasmType> {
  if (!brotliPromise) {
    brotliPromise = import('brotli-wasm').then((m) => m.default || m) as unknown as Promise<BrotliWasmType>;
  }
  return brotliPromise;
}

export async function compressJson(value: unknown): Promise<Uint8Array> {
  const brotli = await getBrotli();
  const json = textEncoder.encode(JSON.stringify(value));
  return brotli.compress(json);
}

// `T` exists purely for the caller's convenience: this function has no way
// to verify the decompressed JSON actually matches `T` (hence the `as T`
// cast, not a runtime check), so callers should only supply it when they
// already know the shape from context (e.g. decryptEntry<Entry> below,
// db.ts, decrypting its own previously-encrypted data). Defaults to
// `unknown` so an uninstantiated call forces the caller to narrow the
// result themselves rather than silently trusting an unchecked shape.
export async function decompressJson<T = unknown>(bytes: Uint8Array): Promise<T> {
  const brotli = await getBrotli();
  const plain = brotli.decompress(bytes);
  return JSON.parse(textDecoder.decode(plain)) as T;
}

export async function encryptEntry(entry: unknown, entryKeyBytes: Uint8Array): Promise<Uint8Array> {
  const compressed = await compressJson(entry);
  return encryptBlob(entryKeyBytes, compressed);
}

// Same unchecked-cast contract as decompressJson above, just threaded
// through one more layer (decrypt, then decompress). db.ts instantiates
// this as `decryptEntry<RawSnapshot[]>` when reading back an entry's history
// array — that annotation is the only thing asserting the ciphertext
// actually decodes to that shape; a corrupt or foreign blob would only be
// caught by decryptBlob's AEAD tag check, not by this generic.
export async function decryptEntry<T = unknown>(entryBlobBytes: Uint8Array, entryKeyBytes: Uint8Array): Promise<T> {
  const compressed = await decryptBlob(entryKeyBytes, entryBlobBytes);
  return decompressJson<T>(compressed);
}

function runSha3_256Hex(lib: LeancryptoModule, inputBytes: Uint8Array): string {
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

export async function sha3_256Hex(inputBytes: Uint8Array): Promise<string> {
  if (!(inputBytes instanceof Uint8Array)) {
    throw new Error('sha3_256Hex expects byte array');
  }
  const lib = await getLc();
  return runSha3_256Hex(lib, inputBytes);
}
