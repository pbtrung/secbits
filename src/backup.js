import {
  fetchRawUserDocs,
  fetchUser,
  getBackupTargets,
  getRootMasterKey,
  getUserMasterKey,
  replaceUserEntries,
} from './api';
import {
  bytesToB64,
  decryptBlobBytes,
  decryptEntryHistoryWithDocKey,
  encryptBytesToBlob,
  encryptEntryHistoryWithDocKey,
  unwrapEntryKey,
  wrapEntryKey,
} from './crypto';

const BACKUP_FILE_NAME = 'secbits.brotli-ascon-keccak.bak';
const AUTO_BACKUP_KEY = 'secbits:auto_backup_enabled';
const LAST_BACKUP_KEY = 'secbits:last_backup_at';
const MAX_RESTORE_BYTES = 10 * 1024 * 1024;
const MAX_DECOMPRESSED_BYTES = 50 * 1024 * 1024;
const ENTRY_ID_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const ENTRY_ID_LEN = 42;

let runningAutoBackup = null;
let rerunAutoBackup = false;
let brotliModulePromise = null;

function valueToBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value && typeof value.toUint8Array === 'function') return value.toUint8Array();
  return null;
}

async function getBrotli() {
  if (!brotliModulePromise) {
    brotliModulePromise = import('brotli-wasm').then((m) => m.default);
  }
  return brotliModulePromise;
}

function b64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function generateEntryId() {
  const buf = crypto.getRandomValues(new Uint8Array(ENTRY_ID_LEN));
  return Array.from(buf, (b) => ENTRY_ID_CHARS[b % ENTRY_ID_CHARS.length]).join('');
}

function normalizePrefix(prefix) {
  if (typeof prefix !== 'string' || prefix.length === 0) return '';
  return prefix.endsWith('/') ? prefix : `${prefix}/`;
}

function resolveEndpoint(target) {
  if (target.target === 'r2') {
    if (!target.account_id) throw new Error('R2 target requires account_id');
    return `https://${target.account_id}.r2.cloudflarestorage.com`;
  }
  if (target.target === 's3') {
    if (!target.region) throw new Error('S3 target requires region');
    return `https://s3.${target.region}.amazonaws.com`;
  }
  if (target.target === 'gcs') return 'https://storage.googleapis.com';
  throw new Error(`Unknown backup target: ${target.target}`);
}

function getTargetRegion(target) {
  if (target.target === 's3') {
    if (!target.region) throw new Error('S3 target requires region');
    return target.region;
  }
  return 'auto';
}

function normalizeTargets(targets) {
  return targets
    .filter((target) => target && typeof target === 'object')
    .map((target) => ({
      ...target,
      target: String(target.target || '').toLowerCase(),
      bucket: String(target.bucket || ''),
      access_key_id: String(target.access_key_id || ''),
      secret_access_key: String(target.secret_access_key || ''),
      prefix: normalizePrefix(target.prefix),
    }))
    .filter((target) =>
      (target.target === 'r2' || target.target === 's3' || target.target === 'gcs')
      && target.bucket
      && target.access_key_id
      && target.secret_access_key
    );
}

export function describeTarget(target) {
  return `${target.target} · ${target.bucket}`;
}

function encodeRfc3986(str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodePath(bucket, key) {
  const parts = String(key)
    .split('/')
    .map((part) => encodeRfc3986(part));
  return `/${encodeRfc3986(bucket)}/${parts.join('/')}`;
}

function amzDateParts(now = new Date()) {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return {
    amzDate: iso,
    dateStamp: iso.slice(0, 8),
  };
}

function concatBytes(...arrays) {
  const total = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const arr of arrays) {
    out.set(arr, offset);
    offset += arr.length;
  }
  return out;
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function hmacSha256(keyBytes, dataBytes) {
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, dataBytes);
  return new Uint8Array(sig);
}

function textBytes(str) {
  return new TextEncoder().encode(str);
}

async function deriveSigningKey(secret, dateStamp, region, service) {
  const kSecret = textBytes(`AWS4${secret}`);
  const kDate = await hmacSha256(kSecret, textBytes(dateStamp));
  const kRegion = await hmacSha256(kDate, textBytes(region));
  const kService = await hmacSha256(kRegion, textBytes(service));
  return hmacSha256(kService, textBytes('aws4_request'));
}

async function sigV4Request({ method, endpoint, bucket, key, region, accessKeyId, secretAccessKey, bodyBytes }) {
  const url = new URL(endpoint);
  const canonicalUri = encodePath(bucket, key);
  const requestUrl = `${url.origin}${canonicalUri}`;
  const host = url.host;
  const { amzDate, dateStamp } = amzDateParts();

  const payloadBytes = bodyBytes ?? new Uint8Array();
  const payloadHash = await sha256Hex(payloadBytes);

  const canonicalHeaders =
    `host:${host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';

  const canonicalRequest =
    `${method}\n${canonicalUri}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign =
    `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${await sha256Hex(textBytes(canonicalRequest))}`;

  const signingKey = await deriveSigningKey(secretAccessKey, dateStamp, region, 's3');
  const signature = await hmacSha256(signingKey, textBytes(stringToSign));
  const signatureHex = Array.from(signature).map((b) => b.toString(16).padStart(2, '0')).join('');
  const authorization =
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signatureHex}`;

  const headers = {
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
    Authorization: authorization,
  };

  const res = await fetch(requestUrl, {
    method,
    headers,
    body: method === 'PUT' ? payloadBytes : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${method} ${describeTarget({ target: endpoint.includes('googleapis') ? 'gcs' : 's3', bucket })} failed (${res.status})${text ? `: ${text.slice(0, 200)}` : ''}`);
  }

  return res;
}

async function uploadToTarget(target, encryptedBlob) {
  const endpoint = resolveEndpoint(target);
  const region = getTargetRegion(target);
  const key = `${target.prefix}${BACKUP_FILE_NAME}`;
  await sigV4Request({
    method: 'PUT',
    endpoint,
    bucket: target.bucket,
    key,
    region,
    accessKeyId: target.access_key_id,
    secretAccessKey: target.secret_access_key,
    bodyBytes: encryptedBlob,
  });
}

async function downloadFromTarget(target) {
  const endpoint = resolveEndpoint(target);
  const region = getTargetRegion(target);
  const key = `${target.prefix}${BACKUP_FILE_NAME}`;
  const res = await sigV4Request({
    method: 'GET',
    endpoint,
    bucket: target.bucket,
    key,
    region,
    accessKeyId: target.access_key_id,
    secretAccessKey: target.secret_access_key,
  });
  return new Uint8Array(await res.arrayBuffer());
}

async function buildDecryptedDocs(userMasterKey) {
  const docs = await fetchRawUserDocs();
  const decryptedDocs = [];
  for (const d of docs) {
    const entry = { id: d.id };
    const entryKeyBytes = valueToBytes(d.entry_key);
    if (entryKeyBytes && userMasterKey) {
      const docKeyBytes = await unwrapEntryKey(userMasterKey, entryKeyBytes);
      entry.entry_key_b64 = bytesToB64(docKeyBytes);
      entry.value = valueToBytes(d.value)
        ? await decryptEntryHistoryWithDocKey(docKeyBytes, d.value)
        : d.value;
    } else {
      entry.entry_key_b64 = entryKeyBytes ? bytesToB64(entryKeyBytes) : d.entry_key;
      entry.value = d.value;
    }
    decryptedDocs.push(entry);
  }
  return decryptedDocs;
}

export function buildExportData({ userId, userData, userMasterKey, decryptedDocs }) {
  return {
    user_id: userId,
    username: userData?.username || null,
    user_master_key_b64: userMasterKey ? bytesToB64(userMasterKey) : null,
    data: decryptedDocs,
  };
}

async function encryptBackupExport(exportData, rootMasterKey) {
  const brotli = await getBrotli();
  const jsonBytes = textBytes(JSON.stringify(exportData));
  const compressed = brotli.compress(jsonBytes);
  return encryptBytesToBlob(rootMasterKey, compressed);
}

async function decryptBackupExport(encryptedBlob, rootMasterKey) {
  const brotli = await getBrotli();
  if (encryptedBlob.byteLength > MAX_RESTORE_BYTES) {
    throw new Error(`Backup file too large (${encryptedBlob.byteLength} B > ${MAX_RESTORE_BYTES} B limit)`);
  }

  const compressed = await decryptBlobBytes(rootMasterKey, encryptedBlob);
  const jsonBytes = brotli.decompress(compressed);
  if (jsonBytes.byteLength > MAX_DECOMPRESSED_BYTES) {
    throw new Error(`Decompressed backup too large (${jsonBytes.byteLength} B > ${MAX_DECOMPRESSED_BYTES} B limit)`);
  }

  return JSON.parse(new TextDecoder().decode(jsonBytes));
}

function buildRawEntriesForRestore(exportData, userMasterKey) {
  return Promise.all(
    exportData.data.map(async (doc) => {
      const docKey = valueToBytes(typeof doc.entry_key_b64 === 'string' ? b64ToBytes(doc.entry_key_b64) : null);
      if (!docKey || docKey.length === 0) {
        throw new Error('Backup entry missing entry_key_b64');
      }
      const wrappedEntryKey = await wrapEntryKey(userMasterKey, docKey);
      const valueBytes = await encryptEntryHistoryWithDocKey(docKey, doc.value);
      return {
        id: generateEntryId(),
        entry_key: bytesToB64(wrappedEntryKey),
        value: bytesToB64(valueBytes),
      };
    }),
  );
}

export function getAutoBackupEnabled() {
  try {
    return localStorage.getItem(AUTO_BACKUP_KEY) === '1';
  } catch {
    return false;
  }
}

export function setAutoBackupEnabled(enabled) {
  try {
    localStorage.setItem(AUTO_BACKUP_KEY, enabled ? '1' : '0');
  } catch {
    // ignore storage failures
  }
}

export function getLastBackupAt() {
  try {
    return sessionStorage.getItem(LAST_BACKUP_KEY);
  } catch {
    return null;
  }
}

function setLastBackupAt(isoTs) {
  try {
    sessionStorage.setItem(LAST_BACKUP_KEY, isoTs);
  } catch {
    // ignore storage failures
  }
}

export async function runBackupNow(userId) {
  const rootMasterKey = getRootMasterKey();
  const userMasterKey = getUserMasterKey();
  const targets = normalizeTargets(getBackupTargets());
  if (!rootMasterKey) throw new Error('Root master key is not initialized');
  if (!userMasterKey) throw new Error('User master key is not initialized');
  if (targets.length === 0) throw new Error('No backup targets configured');

  const [userData, decryptedDocs] = await Promise.all([
    fetchUser(),
    buildDecryptedDocs(userMasterKey),
  ]);
  const exportData = buildExportData({ userId, userData, userMasterKey, decryptedDocs });
  const encryptedBlob = await encryptBackupExport(exportData, rootMasterKey);

  const settled = await Promise.allSettled(
    targets.map(async (target) => {
      await uploadToTarget(target, encryptedBlob);
      return { target, ok: true };
    }),
  );

  const results = settled.map((result, idx) => {
    const target = targets[idx];
    if (result.status === 'fulfilled') {
      return { ok: true, target, label: describeTarget(target) };
    }
    return {
      ok: false,
      target,
      label: describeTarget(target),
      error: result.reason?.message || 'Upload failed',
    };
  });

  if (results.some((r) => r.ok)) {
    setLastBackupAt(new Date().toISOString());
  }

  return { results };
}

export function triggerAutoBackup(userId) {
  if (!getAutoBackupEnabled()) return;
  if (runningAutoBackup) {
    rerunAutoBackup = true;
    return;
  }

  runningAutoBackup = runBackupNow(userId)
    .catch((err) => {
      console.warn('[backup] auto-backup failed:', err?.message || err);
    })
    .finally(() => {
      runningAutoBackup = null;
      if (rerunAutoBackup) {
        rerunAutoBackup = false;
        triggerAutoBackup(userId);
      }
    });
}

export async function runRestore({ userId, source, confirm }) {
  const rootMasterKey = getRootMasterKey();
  const userMasterKey = getUserMasterKey();
  if (!rootMasterKey) throw new Error('Root master key is not initialized');
  if (!userMasterKey) throw new Error('User master key is not initialized');

  let encryptedBlob;
  if (source.type === 'target') {
    const targets = normalizeTargets(getBackupTargets());
    const target = targets[source.index];
    if (!target) throw new Error('Invalid backup target selection');
    encryptedBlob = await downloadFromTarget(target);
  } else if (source.type === 'file') {
    encryptedBlob = new Uint8Array(await source.file.arrayBuffer());
  } else {
    throw new Error('Invalid restore source');
  }

  const exportData = await decryptBackupExport(encryptedBlob, rootMasterKey);
  if (exportData.user_id !== userId) {
    throw new Error('Backup belongs to a different user account; restore aborted.');
  }
  if (!Array.isArray(exportData.data)) {
    throw new Error('Backup is malformed: exportData.data must be an array.');
  }

  if (typeof confirm === 'function') {
    const proceed = await confirm({
      entryCount: exportData.data.length,
      exportData,
    });
    if (!proceed) throw new Error('Restore canceled');
  }

  const rawEntries = await buildRawEntriesForRestore(exportData, userMasterKey);
  await replaceUserEntries(rawEntries);
  return { restoredCount: rawEntries.length };
}
