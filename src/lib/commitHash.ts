import { sha3_256Hex } from '../crypto';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    const keys = Object.keys(value).sort();
    for (const k of keys) out[k] = canonicalize((value as Record<string, unknown>)[k]);
    return out;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export async function computeCommitHash(snapshotWithoutCommitHash: unknown): Promise<string> {
  const payload = new TextEncoder().encode(canonicalJson(snapshotWithoutCommitHash));
  const digestHex = await sha3_256Hex(payload);
  return digestHex.slice(0, 32);
}
