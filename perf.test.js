#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { performance } = require('perf_hooks');
const { randomBytes, randomInt, createHash } = require('crypto');

// Make leancrypto available in Node exactly like src/crypto.js expects.
globalThis.leancrypto = require('./public/leancrypto/leancrypto.js');

const LIMITS = {
  TITLE_MAX: 200,
  USERNAME_MAX: 200,
  PASSWORD_MAX: 1000,
  NOTES_MAX: 100_000,
  URL_MAX: 2048,
  TOTP_SECRET_MAX: 256,
  CUSTOM_FIELD_LABEL_MAX: 100,
  CUSTOM_FIELD_VALUE_MAX: 1000,
  TAG_MAX: 50,
  MAX_URLS: 20,
  MAX_TOTP_SECRETS: 10,
  MAX_CUSTOM_FIELDS: 20,
  MAX_TAGS: 20,
  MAX_COMMITS: 10,
};

const ENTRY_COUNT = 300;
const MAX_VALUE_BYTES = 999_999;
const WORDS_FILE = path.resolve(__dirname, 'data/english-words.txt');
const FETCH_MAX_RETRIES = 5;
const FETCH_BASE_BACKOFF_MS = 400;

const SALT_LEN = 64;
const USER_MASTER_KEY_LEN = 64;
const DOC_KEY_LEN = 64;
const ENC_KEY_LEN = 64;
const ENC_IV_LEN = 64;
const TAG_LEN = 64;
const HKDF_OUT_LEN = ENC_KEY_LEN + ENC_IV_LEN;
const MASTER_BLOB_LEN = SALT_LEN + USER_MASTER_KEY_LEN + TAG_LEN;

const TAG_POOL = [
  'finance', 'work', 'personal', 'infra', 'cloud',
  'dev', 'prod', 'security', 'shared', 'archive',
];

const TRACKED_FIELDS = [
  'title',
  'username',
  'password',
  'notes',
  'urls',
  'totpSecrets',
  'customFields',
  'tags',
];

const ENGLISH_WORDS = loadEnglishWords();

const encoder = new TextEncoder();

let lcPromise = null;

function usageAndExit() {
  console.error('Usage: node perf.test.js <path_to_json_config_file>');
  process.exit(1);
}

function loadEnglishWords() {
  const fallback = [
    'about', 'access', 'account', 'action', 'active', 'agent', 'allow', 'answer', 'backup', 'basic',
    'build', 'change', 'check', 'client', 'cloud', 'common', 'config', 'connect', 'create', 'data',
    'default', 'design', 'device', 'email', 'enable', 'entry', 'error', 'event', 'field', 'filter',
    'future', 'global', 'group', 'health', 'history', 'import', 'input', 'issue', 'label', 'layer',
    'limit', 'local', 'login', 'manage', 'member', 'method', 'mobile', 'module', 'name', 'network',
    'normal', 'notice', 'object', 'option', 'output', 'owner', 'panel', 'path', 'policy', 'process',
    'profile', 'project', 'public', 'query', 'random', 'record', 'region', 'remote', 'report', 'request',
    'result', 'review', 'route', 'sample', 'search', 'secure', 'server', 'service', 'session', 'setting',
    'source', 'stage', 'start', 'state', 'status', 'storage', 'system', 'target', 'team', 'token',
    'update', 'usage', 'user', 'value', 'verify', 'version', 'view', 'window', 'worker', 'workflow',
  ];

  try {
    const text = fs.readFileSync(WORDS_FILE, 'utf8');
    const words = text
      .split(/\r?\n/)
      .map((line) => line.trim().toLowerCase())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => line.replace(/[^a-z]/g, ''))
      .filter((line) => line.length >= 3 && line.length <= 24);

    const unique = Array.from(new Set(words));
    if (unique.length < 300) {
      throw new Error(`word pool too small (${unique.length})`);
    }
    return unique;
  } catch (err) {
    console.warn(`[WARN] Failed to load ${WORDS_FILE}: ${err.message}`);
    console.warn(`[WARN] Using fallback word pool (${fallback.length} words)`);
    return fallback;
  }
}

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

function warnIfFalse(condition, message) {
  if (!condition) console.warn(`[WARN] ${message}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatFetchCause(err) {
  if (!err) return 'unknown';
  const code = err.code ? ` code=${err.code}` : '';
  const errno = err.errno ? ` errno=${err.errno}` : '';
  const syscall = err.syscall ? ` syscall=${err.syscall}` : '';
  const address = err.address ? ` address=${err.address}` : '';
  return `${err.message || String(err)}${code}${errno}${syscall}${address}`;
}

function readConfig(configPath) {
  const resolved = path.resolve(configPath);
  const raw = fs.readFileSync(resolved, 'utf8');
  const json = JSON.parse(raw);

  ensure(json && typeof json === 'object', 'Invalid config JSON');
  ensure(json.auth && typeof json.auth === 'object', 'Missing required field: auth');
  ensure(typeof json.auth.apiKey === 'string' && json.auth.apiKey.length > 0, 'Missing required field: auth.apiKey');
  ensure(typeof json.auth.projectId === 'string' && json.auth.projectId.length > 0, 'Missing required field: auth.projectId');
  ensure(typeof json.email === 'string' && json.email.length > 0, 'Missing required field: email');
  ensure(typeof json.password === 'string' && json.password.length > 0, 'Missing required field: password');
  ensure(typeof json.root_master_key === 'string' && json.root_master_key.length > 0, 'Missing required field: root_master_key');

  return { config: json, configPath: resolved };
}

function b64ToBytes(b64) {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

function bytesToB64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

function decodeRootMasterKey(rootMasterKeyB64) {
  const bytes = b64ToBytes(rootMasterKeyB64);
  if (bytes.length < 256) {
    throw new Error('root_master_key must be at least 256 bytes when decoded');
  }
  return bytes;
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

function writeBytes(lib, data) {
  const ptr = lib._malloc(data.length);
  lib.HEAPU8.set(data, ptr);
  return ptr;
}

function readBytes(lib, ptr, len) {
  return lib.HEAPU8.slice(ptr, ptr + len);
}

function resolveHashPtr(lib, sym) {
  return lib.HEAPU32[sym >> 2];
}

async function getLc() {
  if (!lcPromise) {
    lcPromise = Promise.resolve()
      .then(() => {
        if (typeof globalThis.leancrypto !== 'function') {
          throw new Error('leancrypto global loader not available');
        }
        return globalThis.leancrypto();
      })
      .then((lib) => {
        lib._lc_init();
        return lib;
      });
  }
  return lcPromise;
}

function brotliCompress(bytes) {
  return new Uint8Array(
    zlib.brotliCompressSync(Buffer.from(bytes), {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 5,
      },
    })
  );
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

async function encryptBytesToBlob(keyBytes, plainBytes) {
  const lib = await getLc();
  const salt = randomBytes(SALT_LEN);
  const { encKey, encIv } = hkdfSync(lib, keyBytes, salt);
  const { ciphertext, tag } = akEncrypt(lib, encKey, encIv, plainBytes);
  return concat(salt, ciphertext, tag);
}

async function decryptBlobBytes(keyBytes, blob) {
  if (blob.length < SALT_LEN + TAG_LEN) throw new Error('Invalid encrypted value');

  const salt = blob.slice(0, SALT_LEN);
  const ciphertext = blob.slice(SALT_LEN, blob.length - TAG_LEN);
  const tag = blob.slice(blob.length - TAG_LEN);

  const lib = await getLc();
  const { encKey, encIv } = hkdfSync(lib, keyBytes, salt);
  return akDecrypt(lib, encKey, encIv, ciphertext, tag);
}

async function wrapEntryKey(userMasterKey, docKeyBytes) {
  if (!(docKeyBytes instanceof Uint8Array) || docKeyBytes.length !== DOC_KEY_LEN) {
    throw new Error('docKeyBytes must be 64 bytes');
  }
  return encryptBytesToBlob(userMasterKey, docKeyBytes);
}

async function encryptEntryHistoryWithDocKey(docKeyBytes, history) {
  const plain = encoder.encode(JSON.stringify(history));
  const compressed = brotliCompress(plain);
  return encryptBytesToBlob(docKeyBytes, compressed);
}

async function setupUserMasterKey(rootMasterKeyBytes) {
  const lib = await getLc();
  const salt = randomBytes(SALT_LEN);
  const { encKey, encIv } = hkdfSync(lib, rootMasterKeyBytes, salt);

  const userMasterKey = randomBytes(USER_MASTER_KEY_LEN);
  const { ciphertext, tag } = akEncrypt(lib, encKey, encIv, userMasterKey);

  return {
    userMasterKeyBlob: concat(salt, ciphertext, tag),
    userMasterKey,
  };
}

async function verifyUserMasterKey(rootMasterKeyBytes, storedUserMasterKeyBlob) {
  const blob = storedUserMasterKeyBlob;
  if (!(blob instanceof Uint8Array) || blob.length !== MASTER_BLOB_LEN) {
    throw new Error('Invalid stored user_master_key data');
  }

  const salt = blob.slice(0, SALT_LEN);
  const encUserMasterKey = blob.slice(SALT_LEN, SALT_LEN + USER_MASTER_KEY_LEN);
  const tag = blob.slice(SALT_LEN + USER_MASTER_KEY_LEN);

  const lib = await getLc();
  const { encKey, encIv } = hkdfSync(lib, rootMasterKeyBytes, salt);
  return akDecrypt(lib, encKey, encIv, encUserMasterKey, tag);
}

function randomChoice(arr) {
  return arr[randomInt(0, arr.length)];
}

function randomDistinct(arr, n) {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

function randomAlphaNumeric(length) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += chars[bytes[i] % chars.length];
  return out;
}

function randomUsername(length) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789._-';
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += chars[bytes[i] % chars.length];
  return out;
}

function randomPassword(length) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()-_=+[]{}<>?';
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += chars[bytes[i] % chars.length];
  return out;
}

function randomWords(minWords, maxWords) {
  const count = randomInt(minWords, maxWords + 1);
  const words = [];
  for (let i = 0; i < count; i++) words.push(randomChoice(ENGLISH_WORDS));
  return words.join(' ');
}

function randomWordStringByLength(minLen, maxLen) {
  let out = '';
  while (out.length < minLen) {
    out = out ? `${out} ${randomChoice(ENGLISH_WORDS)}` : randomChoice(ENGLISH_WORDS);
  }
  if (out.length > maxLen) out = out.slice(0, maxLen);
  if (out.length < minLen) out = out.padEnd(minLen, randomAlphaNumeric(1));
  return out;
}

function randomUrl() {
  const host = `${randomChoice(ENGLISH_WORDS)}-${randomChoice(ENGLISH_WORDS)}${randomInt(10, 999)}.example.com`;
  const pathPart = `${randomChoice(ENGLISH_WORDS)}/${randomChoice(ENGLISH_WORDS)}/${randomAlphaNumeric(randomInt(8, 18)).toLowerCase()}`;
  const query = `v=${randomInt(1, 999)}&k=${randomAlphaNumeric(randomInt(6, 10)).toLowerCase()}`;
  return `https://${host}/${pathPart}?${query}`;
}

function randomBase32(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += chars[bytes[i] % chars.length];
  return out;
}

function generateCustomFields() {
  const count = randomInt(2, 6);
  const fields = [];
  for (let i = 0; i < count; i++) {
    fields.push({
      id: i + 1,
      label: randomWordStringByLength(4, 16).slice(0, LIMITS.CUSTOM_FIELD_LABEL_MAX),
      value: randomWords(2, 8).slice(0, LIMITS.CUSTOM_FIELD_VALUE_MAX),
    });
  }
  return fields;
}

function generateSnapshot(baseTimeMs, offsetSec) {
  const titleLen = randomInt(10, 31);
  const usernameLen = randomInt(10, 31);
  const passwordLen = randomInt(20, 41);
  const urlCount = randomInt(1, 3);
  const totpCount = randomInt(1, 3);
  const tagCount = randomInt(1, 6);

  return {
    title: randomWordStringByLength(10, 30).slice(0, titleLen),
    username: randomUsername(usernameLen).slice(0, LIMITS.USERNAME_MAX),
    password: randomPassword(passwordLen).slice(0, LIMITS.PASSWORD_MAX),
    notes: randomWords(30, 300).slice(0, LIMITS.NOTES_MAX),
    urls: Array.from({ length: urlCount }, () => randomUrl().slice(0, LIMITS.URL_MAX)),
    totpSecrets: Array.from({ length: totpCount }, () => randomBase32(randomInt(16, 33)).slice(0, LIMITS.TOTP_SECRET_MAX)),
    customFields: generateCustomFields().slice(0, LIMITS.MAX_CUSTOM_FIELDS),
    tags: randomDistinct(TAG_POOL, tagCount).map((t) => t.slice(0, LIMITS.TAG_MAX)).slice(0, LIMITS.MAX_TAGS),
    timestamp: new Date(baseTimeMs + offsetSec * 1000).toISOString(),
  };
}

function changedFields(prev, next) {
  return TRACKED_FIELDS.filter((field) => JSON.stringify(prev[field]) !== JSON.stringify(next[field]));
}

function mutateSnapshot(prev, baseTimeMs, offsetSec) {
  const next = JSON.parse(JSON.stringify(prev));
  const minChanged = Math.ceil(TRACKED_FIELDS.length * 0.3);
  const maxChanged = Math.min(TRACKED_FIELDS.length, 6);
  const mutateCount = randomInt(minChanged, maxChanged + 1);
  const fields = randomDistinct(TRACKED_FIELDS, mutateCount);

  for (const field of fields) {
    if (field === 'title') next.title = randomWordStringByLength(10, 30);
    if (field === 'username') next.username = randomUsername(randomInt(10, 31));
    if (field === 'password') next.password = randomPassword(randomInt(20, 41));
    if (field === 'notes') next.notes = randomWords(30, 300);
    if (field === 'urls') next.urls = Array.from({ length: randomInt(1, 3) }, () => randomUrl());
    if (field === 'totpSecrets') next.totpSecrets = Array.from({ length: randomInt(1, 3) }, () => randomBase32(randomInt(16, 33)));
    if (field === 'customFields') next.customFields = generateCustomFields();
    if (field === 'tags') next.tags = randomDistinct(TAG_POOL, randomInt(1, 6));
  }

  next.timestamp = new Date(baseTimeMs + offsetSec * 1000).toISOString();
  return next;
}

function hashContent(snapshot) {
  const { timestamp, ...content } = snapshot;
  const stable = {};
  for (const key of Object.keys(content).sort()) stable[key] = content[key];
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex').slice(0, 12);
}

function buildSnapshotDelta(previousSnapshot, nextSnapshot) {
  const prev = previousSnapshot && typeof previousSnapshot === 'object' ? previousSnapshot : {};
  const next = nextSnapshot && typeof nextSnapshot === 'object' ? nextSnapshot : {};

  const set = {};
  const unset = [];
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);

  for (const key of keys) {
    const prevHas = Object.prototype.hasOwnProperty.call(prev, key);
    const nextHas = Object.prototype.hasOwnProperty.call(next, key);
    if (!nextHas) {
      unset.push(key);
      continue;
    }
    if (!prevHas || JSON.stringify(prev[key]) !== JSON.stringify(next[key])) {
      set[key] = next[key];
    }
  }

  return { set, unset };
}

function serializeHistoryForStorage(history) {
  const commits = Array.isArray(history && history.commits) ? history.commits.slice(0, LIMITS.MAX_COMMITS) : [];
  if (commits.length === 0) {
    return { head: null, head_snapshot: null, commits: [] };
  }

  const snapshots = commits.map((c) => c.snapshot);
  const compactCommits = commits.map((commit, index) => {
    const compact = {
      hash: commit.hash,
      parent: commit.parent,
      timestamp: commit.timestamp,
      changed: Array.isArray(commit.changed) ? commit.changed : [],
    };
    if (index > 0) {
      compact.delta = buildSnapshotDelta(snapshots[index - 1], snapshots[index]);
    }
    return compact;
  });

  return {
    head: history.head || compactCommits[0].hash || null,
    head_snapshot: snapshots[0],
    commits: compactCommits,
  };
}

function validateEntry(entry, index) {
  ensure(entry.versions.length >= 3 && entry.versions.length <= 10, `Invalid versions count at entry ${index}`);
  for (let i = 0; i < entry.versions.length; i++) {
    const v = entry.versions[i];
    ensure(typeof v.title === 'string' && v.title.length >= 10 && v.title.length <= 30, `Invalid title length at entry ${index}, version ${i}`);
    ensure(typeof v.username === 'string' && v.username.length >= 10 && v.username.length <= 30, `Invalid username length at entry ${index}, version ${i}`);
    ensure(typeof v.password === 'string' && v.password.length >= 20 && v.password.length <= 40, `Invalid password length at entry ${index}, version ${i}`);
    ensure(typeof v.notes === 'string', `Invalid notes at entry ${index}, version ${i}`);

    const noteWords = v.notes.trim().split(/\s+/).filter(Boolean).length;
    ensure(noteWords >= 30 && noteWords <= 300, `Invalid note word count at entry ${index}, version ${i}`);

    ensure(Array.isArray(v.urls) && v.urls.length >= 1 && v.urls.length <= 2, `Invalid urls count at entry ${index}, version ${i}`);
    ensure(Array.isArray(v.totpSecrets) && v.totpSecrets.length >= 1 && v.totpSecrets.length <= 2, `Invalid totpSecrets count at entry ${index}, version ${i}`);
    ensure(Array.isArray(v.customFields) && v.customFields.length >= 2 && v.customFields.length <= 5, `Invalid customFields count at entry ${index}, version ${i}`);
    ensure(Array.isArray(v.tags) && v.tags.length >= 1 && v.tags.length <= 5, `Invalid tags count at entry ${index}, version ${i}`);

    ensure(v.title.length <= LIMITS.TITLE_MAX, `Title exceeds app max at entry ${index}, version ${i}`);
    ensure(v.username.length <= LIMITS.USERNAME_MAX, `Username exceeds app max at entry ${index}, version ${i}`);
    ensure(v.password.length <= LIMITS.PASSWORD_MAX, `Password exceeds app max at entry ${index}, version ${i}`);
    ensure(v.notes.length <= LIMITS.NOTES_MAX, `Notes exceeds app max at entry ${index}, version ${i}`);
    ensure(v.urls.every((u) => u.length <= LIMITS.URL_MAX), `URL exceeds app max at entry ${index}, version ${i}`);
    ensure(v.totpSecrets.every((s) => s.length <= LIMITS.TOTP_SECRET_MAX), `TOTP secret exceeds app max at entry ${index}, version ${i}`);
    ensure(v.customFields.every((f) => String(f.label).length <= LIMITS.CUSTOM_FIELD_LABEL_MAX), `Custom field label too long at entry ${index}, version ${i}`);
    ensure(v.customFields.every((f) => String(f.value).length <= LIMITS.CUSTOM_FIELD_VALUE_MAX), `Custom field value too long at entry ${index}, version ${i}`);
    ensure(v.tags.every((t) => String(t).length <= LIMITS.TAG_MAX), `Tag too long at entry ${index}, version ${i}`);

    if (i > 0) {
      const diffRatio = changedFields(entry.versions[i - 1], v).length / TRACKED_FIELDS.length;
      warnIfFalse(diffRatio >= 0.3, `Diff ratio below 30% at entry ${index}, version ${i}`);
    }
  }
}

function generateEntry(entryIndex) {
  const versionCount = randomInt(3, LIMITS.MAX_COMMITS + 1);
  const baseTimeMs = Date.now() - randomInt(1000, 30 * 24 * 3600 * 1000);
  const versions = [];

  versions.push(generateSnapshot(baseTimeMs, 0));
  for (let i = 1; i < versionCount; i++) {
    const next = mutateSnapshot(versions[i - 1], baseTimeMs, i * randomInt(15, 120));
    const ratio = changedFields(versions[i - 1], next).length / TRACKED_FIELDS.length;
    warnIfFalse(ratio >= 0.3, `Version diff <30% at entry ${entryIndex}, version ${i}`);
    versions.push(next);
  }

  const commitsOldestFirst = versions.map((snapshot, i) => ({
    hash: hashContent(snapshot),
    parent: i === 0 ? null : hashContent(versions[i - 1]),
    timestamp: snapshot.timestamp,
    changed: i === 0 ? [] : changedFields(versions[i - 1], snapshot),
    snapshot,
  }));

  const commits = commitsOldestFirst.reverse();
  return {
    id: `perf-${String(entryIndex + 1).padStart(4, '0')}`,
    versions,
    history: {
      head: commits[0].hash,
      commits,
    },
  };
}

async function jsonFetch(url, options) {
  for (let attempt = 1; attempt <= FETCH_MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, options);
      const text = await res.text();
      const data = text ? JSON.parse(text) : {};
      if (!res.ok) {
        const msg = data && data.error && data.error.message ? data.error.message : `HTTP ${res.status}`;
        const retriable = res.status === 429 || (res.status >= 500 && res.status <= 599);
        if (retriable && attempt < FETCH_MAX_RETRIES) {
          const delay = FETCH_BASE_BACKOFF_MS * attempt;
          console.log(`[RETRY] ${res.status} from ${url} (attempt ${attempt}/${FETCH_MAX_RETRIES}), waiting ${delay}ms`);
          await sleep(delay);
          continue;
        }
        throw new Error(`Request failed (${res.status}) ${url}: ${msg}`);
      }
      return data;
    } catch (err) {
      // Network-layer failure (DNS/TLS/socket/reset) before any HTTP response.
      const isNetworkFailure = err instanceof TypeError || String(err && err.message || '').toLowerCase().includes('fetch failed');
      if (isNetworkFailure && attempt < FETCH_MAX_RETRIES) {
        const delay = FETCH_BASE_BACKOFF_MS * attempt;
        const causeText = formatFetchCause(err && err.cause ? err.cause : err);
        console.log(`[RETRY] network error on ${url} (attempt ${attempt}/${FETCH_MAX_RETRIES}): ${causeText}; waiting ${delay}ms`);
        await sleep(delay);
        continue;
      }
      const causeText = formatFetchCause(err && err.cause ? err.cause : err);
      throw new Error(`Network request failed: ${url}; ${causeText}`);
    }
  }
  throw new Error(`Network request failed after retries: ${url}`);
}

async function signInWithPassword(apiKey, email, password) {
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(apiKey)}`;
  return jsonFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email,
      password,
      returnSecureToken: true,
    }),
  });
}

function firestoreBase(projectId, dbName) {
  const databaseId = dbName && String(dbName).trim() ? String(dbName).trim() : '(default)';
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/${encodeURIComponent(databaseId)}/documents`;
}

async function getUserDoc(base, uid, idToken) {
  return jsonFetch(`${base}/users/${encodeURIComponent(uid)}`, {
    method: 'GET',
    headers: { authorization: `Bearer ${idToken}` },
  });
}

async function patchUserMasterKey(base, uid, idToken, blobBytes) {
  const url = `${base}/users/${encodeURIComponent(uid)}?updateMask.fieldPaths=user_master_key`;
  return jsonFetch(url, {
    method: 'PATCH',
    headers: {
      authorization: `Bearer ${idToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      fields: {
        user_master_key: { bytesValue: bytesToB64(blobBytes) },
      },
    }),
  });
}

async function writeEntryDoc(base, uid, docId, idToken, entryKeyBytes, valueBytes) {
  const url = `${base}/users/${encodeURIComponent(uid)}/data/${encodeURIComponent(docId)}`;
  return jsonFetch(url, {
    method: 'PATCH',
    headers: {
      authorization: `Bearer ${idToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      fields: {
        entry_key: { bytesValue: bytesToB64(entryKeyBytes) },
        value: { bytesValue: bytesToB64(valueBytes) },
      },
    }),
  });
}

async function resolveUserMasterKey({ base, uid, idToken, rootMasterKeyBytes }) {
  const userDoc = await getUserDoc(base, uid, idToken);
  const fields = userDoc && userDoc.fields ? userDoc.fields : {};
  const stored = fields.user_master_key && fields.user_master_key.bytesValue
    ? b64ToBytes(fields.user_master_key.bytesValue)
    : null;

  if (!stored) {
    console.log('[AUTH] user_master_key missing; creating and saving a new one');
    const { userMasterKeyBlob, userMasterKey } = await setupUserMasterKey(rootMasterKeyBytes);
    await patchUserMasterKey(base, uid, idToken, userMasterKeyBlob);
    return userMasterKey;
  }

  console.log('[AUTH] user_master_key found; verifying root_master_key');
  return verifyUserMasterKey(rootMasterKeyBytes, stored);
}

function formatDurationMs(ms) {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

async function main() {
  const configPathArg = process.argv[2];
  if (!configPathArg) usageAndExit();

  const { config, configPath } = readConfig(configPathArg);
  const rootMasterKeyBytes = decodeRootMasterKey(config.root_master_key);

  console.log(`[START] Config: ${configPath}`);
  console.log('[AUTH] signing in with Firebase email/password');
  const authResp = await signInWithPassword(config.auth.apiKey, config.email, config.password);
  const uid = authResp.localId;
  const idToken = authResp.idToken;
  ensure(uid && idToken, 'Authentication response missing uid/idToken');
  console.log(`[AUTH] signed in as uid=${uid}`);

  const base = firestoreBase(config.auth.projectId, config.db_name || '');
  const userMasterKey = await resolveUserMasterKey({
    base,
    uid,
    idToken,
    rootMasterKeyBytes,
  });

  const startedAt = performance.now();
  let totalVersions = 0;
  let totalPayloadBytes = 0;

  for (let i = 0; i < ENTRY_COUNT; i++) {
    const idx = i + 1;
    const entryStart = performance.now();

    const entry = generateEntry(i);
    validateEntry(entry, i);
    totalVersions += entry.versions.length;

    const compactHistory = serializeHistoryForStorage(entry.history);

    const docKeyBytes = randomBytes(DOC_KEY_LEN);
    const entryKeyBlob = await wrapEntryKey(userMasterKey, docKeyBytes);
    const valueBlob = await encryptEntryHistoryWithDocKey(docKeyBytes, compactHistory);

    if (valueBlob.length > MAX_VALUE_BYTES) {
      throw new Error(`Entry ${entry.id} value blob too large: ${valueBlob.length} bytes`);
    }

    await writeEntryDoc(base, uid, entry.id, idToken, entryKeyBlob, valueBlob);

    const entryMs = performance.now() - entryStart;
    const elapsed = performance.now() - startedAt;
    const avgPerEntry = elapsed / idx;
    const remaining = avgPerEntry * (ENTRY_COUNT - idx);
    const payloadBytes = entryKeyBlob.length + valueBlob.length;
    totalPayloadBytes += payloadBytes;

    console.log(
      `[ADD ${idx}/${ENTRY_COUNT}] id=${entry.id} versions=${entry.versions.length} ` +
      `entry_key=${entryKeyBlob.length}B value=${valueBlob.length}B total=${payloadBytes}B ` +
      `entry_time=${formatDurationMs(entryMs)} elapsed=${formatDurationMs(elapsed)} eta=${formatDurationMs(remaining)}`
    );
  }

  const totalMs = performance.now() - startedAt;
  const avgVersions = totalVersions / ENTRY_COUNT;

  console.log('');
  console.log('[DONE] Firestore performance dataset inserted successfully');
  console.log(`- Entries inserted: ${ENTRY_COUNT}`);
  console.log(`- Total versions: ${totalVersions}`);
  console.log(`- Avg versions/entry: ${avgVersions.toFixed(2)}`);
  console.log(`- Total encrypted payload written: ${totalPayloadBytes} bytes`);
  console.log(`- Total write time: ${formatDurationMs(totalMs)}`);

  // Best-effort zeroization.
  userMasterKey.fill(0);
  rootMasterKeyBytes.fill(0);
}

main().catch((err) => {
  console.error('[ERROR]', err && err.message ? err.message : err);
  if (err && err.stack) {
    console.error('[STACK]', err.stack);
  }
  process.exit(1);
});
