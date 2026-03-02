import { sha3_256Hex } from './crypto';

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out = {};
    const keys = Object.keys(value).sort();
    for (const k of keys) out[k] = canonicalize(value[k]);
    return out;
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export async function computeCommitHash(snapshotWithoutCommitHash) {
  const payload = new TextEncoder().encode(canonicalJson(snapshotWithoutCommitHash));
  const digestHex = await sha3_256Hex(payload);
  return digestHex.slice(0, 32);
}
