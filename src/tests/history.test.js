import { beforeAll, describe, expect, it } from 'vitest';
import leancrypto from '../../leancrypto/leancrypto.js';
import { generateEntryKey, encryptEntry, bytesToB64 } from '../lib/crypto.js';
import { canonicalJson, computeCommitHash } from '../lib/commitHash.js';
import { __historyFormatTestOnly } from '../lib/api.js';

const { decodeHistorySnapshots } = __historyFormatTestOnly;

beforeAll(() => {
  globalThis.leancrypto = leancrypto;
});

// Build an encrypted snapshot row from a plain snapshot object and an entry key.
async function makeHistoryRow(snapshot, rawEntryKey, createdAt = '2026-01-01T00:00:00.000Z') {
  const blob = await encryptEntry(snapshot, rawEntryKey);
  return {
    id: Math.random().toString(36).slice(2),
    entry_id: 'entry-1',
    encrypted_snapshot: bytesToB64(blob),
    created_at: createdAt,
  };
}

function makeSnapshot(overrides = {}) {
  return {
    type: 'login',
    title: 'Test Entry',
    username: 'alice',
    password: 'pw',
    notes: '',
    urls: [],
    totpSecrets: [],
    customFields: [],
    tags: [],
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe('decodeHistorySnapshots', () => {
  it('single row produces one commit with null parent', async () => {
    const rawKey = generateEntryKey();
    const snap = makeSnapshot();
    const hash = await computeCommitHash(snap);
    const row = await makeHistoryRow({ ...snap, commit_hash: hash }, rawKey);

    const commits = await decodeHistorySnapshots([row], rawKey);
    expect(commits).toHaveLength(1);
    expect(commits[0].parent).toBeNull();
    expect(commits[0].changed).toEqual([]);
  });

  it('two rows: newest-first, second commit has parent hash of first', async () => {
    const rawKey = generateEntryKey();
    const snap1 = makeSnapshot({ title: 'v1' });
    const snap2 = makeSnapshot({ title: 'v2' });
    const hash1 = await computeCommitHash(snap1);
    const hash2 = await computeCommitHash(snap2);

    // history rows arrive newest-first (as the backend returns them)
    const row2 = await makeHistoryRow({ ...snap2, commit_hash: hash2 }, rawKey, '2026-01-02T00:00:00.000Z');
    const row1 = await makeHistoryRow({ ...snap1, commit_hash: hash1 }, rawKey, '2026-01-01T00:00:00.000Z');

    const commits = await decodeHistorySnapshots([row2, row1], rawKey);
    expect(commits).toHaveLength(2);
    expect(commits[0].snapshot.title).toBe('v2');
    expect(commits[1].snapshot.title).toBe('v1');
    // newest commit's parent is the hash of the older snapshot
    expect(commits[0].parent).toBe(hash1);
  });

  it('changed fields are detected between consecutive commits', async () => {
    const rawKey = generateEntryKey();
    const snap1 = makeSnapshot({ title: 'original', password: 'old-pw' });
    const snap2 = makeSnapshot({ title: 'original', password: 'new-pw' });
    const hash1 = await computeCommitHash(snap1);
    const hash2 = await computeCommitHash(snap2);
    const row2 = await makeHistoryRow({ ...snap2, commit_hash: hash2 }, rawKey, '2026-01-02T00:00:00.000Z');
    const row1 = await makeHistoryRow({ ...snap1, commit_hash: hash1 }, rawKey, '2026-01-01T00:00:00.000Z');

    const commits = await decodeHistorySnapshots([row2, row1], rawKey);
    expect(commits[0].changed).toContain('password');
    expect(commits[0].changed).not.toContain('title');
  });

  it('caps output at MAX_COMMITS (20) even when more rows are supplied', async () => {
    const rawKey = generateEntryKey();
    const rows = [];
    for (let i = 21; i >= 1; i--) {
      const snap = makeSnapshot({ title: `v${i}` });
      const hash = await computeCommitHash(snap);
      const ts = `2026-01-${String(i).padStart(2, '0')}T00:00:00.000Z`;
      rows.push(await makeHistoryRow({ ...snap, commit_hash: hash }, rawKey, ts));
    }
    const commits = await decodeHistorySnapshots(rows, rawKey);
    expect(commits).toHaveLength(20);
  });

  it('decrypting any snapshot with entry_key recovers the original entry JSON', async () => {
    const rawKey = generateEntryKey();
    const snap = makeSnapshot({ title: 'Recover Me', username: 'bob' });
    const hash = await computeCommitHash(snap);
    const row = await makeHistoryRow({ ...snap, commit_hash: hash }, rawKey);

    const commits = await decodeHistorySnapshots([row], rawKey);
    expect(commits[0].snapshot.title).toBe('Recover Me');
    expect(commits[0].snapshot.username).toBe('bob');
  });

  it('commit hash in snapshot equals SHA3-256(canonicalJson(snapshotWithoutHash)).slice(0,32)', async () => {
    const rawKey = generateEntryKey();
    const snap = makeSnapshot({ title: 'Hash Check' });
    const snapshotForHash = { ...snap };
    const expectedHash = await computeCommitHash(snapshotForHash);
    expect(expectedHash).toMatch(/^[0-9a-f]{32}$/);

    const row = await makeHistoryRow({ ...snap, commit_hash: expectedHash }, rawKey);
    const commits = await decodeHistorySnapshots([row], rawKey);
    expect(commits[0].hash).toBe(expectedHash);
  });

  it('commit hash is SHA3-256-based: canonical key ordering is stable', async () => {
    // Two objects with the same keys in different order must produce the same hash
    const a = { type: 'login', title: 'x', username: 'y', password: 'z', notes: '', urls: [], totpSecrets: [], customFields: [], tags: [], timestamp: '2026-01-01T00:00:00.000Z' };
    const b = { timestamp: a.timestamp, tags: a.tags, customFields: a.customFields, totpSecrets: a.totpSecrets, urls: a.urls, notes: a.notes, password: a.password, username: a.username, title: a.title, type: a.type };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(await computeCommitHash(a)).toBe(await computeCommitHash(b));
  });
});
