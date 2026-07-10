import { beforeAll, describe, expect, it } from 'vitest';
import leancrypto from '../../leancrypto/leancrypto.js';
import { canonicalJson, computeCommitHash } from '../lib/commitHash.js';

beforeAll(() => {
  globalThis.leancrypto = leancrypto;
});

describe('commit hash', () => {
  it('same JSON yields same hash', async () => {
    const a = { b: 2, a: 1 };
    const h1 = await computeCommitHash(a);
    const h2 = await computeCommitHash({ a: 1, b: 2 });
    expect(h1).toBe(h2);
  });

  it('different JSON yields different hash', async () => {
    const h1 = await computeCommitHash({ a: 1 });
    const h2 = await computeCommitHash({ a: 2 });
    expect(h1).not.toBe(h2);
  });

  it('hash length is exactly 32 lowercase hex chars', async () => {
    const h = await computeCommitHash({ title: 'x' });
    expect(h).toMatch(/^[0-9a-f]{32}$/);
  });

  it('empty object canonical hash matches SHA3-256 reference truncation', async () => {
    const h = await computeCommitHash({});
    expect(canonicalJson({})).toBe('{}');
    expect(h).toBe('840eb7aa2a9935de63366bacbe9d97e9');
  });
});
