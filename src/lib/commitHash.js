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

function toHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export async function computeCommitHash(snapshotWithoutCommitHash) {
  const payload = new TextEncoder().encode(canonicalJson(snapshotWithoutCommitHash));
  const digest = await crypto.subtle.digest('SHA-256', payload);
  return toHex(new Uint8Array(digest)).slice(0, 32);
}
