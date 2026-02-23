import { describe, expect, it } from 'vitest';
import { __historyFormatTestOnly } from '../firebase.js';

const { applySnapshotDelta, buildSnapshotDelta, parseHistoryJson, serializeHistoryForStorage } = __historyFormatTestOnly;

describe('firebase history storage format', () => {
  it('stores head snapshot + deltas and reconstructs full snapshots', () => {
    const history = {
      head: 'h3',
      commits: [
        {
          hash: 'h3',
          parent: 'h2',
          timestamp: '2026-02-21T00:03:00.000Z',
          changed: ['notes', 'tags'],
          snapshot: {
            title: 'entry',
            username: 'alice',
            password: 'p2',
            notes: 'note v3',
            urls: ['https://a.example'],
            totpSecrets: [],
            customFields: [{ id: 1, label: 'api', value: 'k3' }],
            tags: ['prod'],
            timestamp: '2026-02-21T00:03:00.000Z',
          },
        },
        {
          hash: 'h2',
          parent: 'h1',
          timestamp: '2026-02-21T00:02:00.000Z',
          changed: ['password', 'notes'],
          snapshot: {
            title: 'entry',
            username: 'alice',
            password: 'p1',
            notes: 'note v2',
            urls: ['https://a.example'],
            totpSecrets: [],
            customFields: [{ id: 1, label: 'api', value: 'k2' }],
            tags: [],
            timestamp: '2026-02-21T00:02:00.000Z',
          },
        },
        {
          hash: 'h1',
          parent: null,
          timestamp: '2026-02-21T00:01:00.000Z',
          changed: [],
          snapshot: {
            title: 'entry',
            username: 'alice',
            password: 'p1',
            notes: 'note v1',
            urls: ['https://a.example'],
            totpSecrets: [],
            customFields: [{ id: 1, label: 'api', value: 'k1' }],
            tags: [],
            timestamp: '2026-02-21T00:01:00.000Z',
          },
        },
      ],
    };

    const compact = serializeHistoryForStorage(history);
    expect(compact.head_snapshot).toEqual(history.commits[0].snapshot);
    expect(compact.commits[0].delta).toBeUndefined();
    expect(compact.commits[1].delta).toBeDefined();
    expect(compact.commits[2].delta).toBeDefined();
    expect(compact.commits[1].snapshot).toBeUndefined();
    expect(compact.commits[2].snapshot).toBeUndefined();

    const parsed = parseHistoryJson(compact);
    expect(parsed.head).toBe('h3');
    expect(parsed.commits).toHaveLength(3);
    expect(parsed.commits[0].snapshot).toEqual(history.commits[0].snapshot);
    expect(parsed.commits[1].snapshot).toEqual(history.commits[1].snapshot);
    expect(parsed.commits[2].snapshot).toEqual(history.commits[2].snapshot);

    const legacyJsonLen = JSON.stringify(history).length;
    const compactJsonLen = JSON.stringify(compact).length;
    expect(compactJsonLen).toBeLessThan(legacyJsonLen);
  });

  it('returns empty history for non-compact payloads', () => {

    const nonCompact = {
      head: 'h2',
      commits: [
        {
          hash: 'h2',
          parent: 'h1',
          timestamp: '2026-02-21T00:02:00.000Z',
          changed: ['customFields'],
          snapshot: {
            title: 'entry',
            username: '',
            password: '',
            notes: '',
            urls: [],
            totpSecrets: [],
            customFields: [{ id: 1, label: 'token', value: 'abc' }],
            tags: [],
            timestamp: '2026-02-21T00:02:00.000Z',
          },
        },
        {
          hash: 'h1',
          parent: null,
          timestamp: '2026-02-21T00:01:00.000Z',
          changed: [],
          snapshot: {
            title: 'entry',
            username: '',
            password: '',
            notes: '',
            urls: [],
            totpSecrets: [],
            customFields: [],
            tags: [],
            timestamp: '2026-02-21T00:01:00.000Z',
          },
        },
      ],
    };

    const parsed = parseHistoryJson(nonCompact);
    expect(parsed.head).toBe('h2');
    expect(parsed.commits).toHaveLength(0);
  });
});

const BASE_SNAPSHOT = {
  title: 'entry',
  username: 'alice',
  password: 'p1',
  notes: 'note',
  urls: ['https://a.example'],
  totpSecrets: [],
  customFields: [],
  tags: [],
  timestamp: '2026-02-21T00:01:00.000Z',
};

describe('buildSnapshotDelta', () => {
  it('detects a changed field', () => {
    const B = { ...BASE_SNAPSHOT, password: 'p2' };
    const delta = buildSnapshotDelta(BASE_SNAPSHOT, B);
    expect(delta.set.password).toBe('p2');
    expect(delta.unset).toHaveLength(0);
  });

  it('detects a removed key', () => {
    const B = { ...BASE_SNAPSHOT };
    delete B.notes;
    const delta = buildSnapshotDelta(BASE_SNAPSHOT, B);
    expect(delta.unset).toContain('notes');
    expect(Object.prototype.hasOwnProperty.call(delta.set, 'notes')).toBe(false);
  });

  it('produces empty set and unset for identical snapshots', () => {
    const delta = buildSnapshotDelta(BASE_SNAPSHOT, BASE_SNAPSHOT);
    expect(delta.set).toEqual({});
    expect(delta.unset).toEqual([]);
  });

  it('apply round-trip reconstructs B from A and delta', () => {
    const B = { ...BASE_SNAPSHOT, password: 'p2', notes: 'new note' };
    const result = applySnapshotDelta(BASE_SNAPSHOT, buildSnapshotDelta(BASE_SNAPSHOT, B));
    expect(result.password).toBe(B.password);
    expect(result.notes).toBe(B.notes);
    expect(result.title).toBe(B.title);
    expect(result.username).toBe(B.username);
    expect(result.tags).toEqual(B.tags);
    expect(result.urls).toEqual(B.urls);
  });

  it('null delta returns snapshot unchanged (normalized)', () => {
    const result = applySnapshotDelta(BASE_SNAPSHOT, null);
    expect(result.title).toBe(BASE_SNAPSHOT.title);
    expect(result.password).toBe(BASE_SNAPSHOT.password);
  });
});

describe('single-commit history edge case', () => {
  const snapshot = {
    title: 'only entry',
    username: '',
    password: 'pw',
    notes: '',
    urls: [],
    totpSecrets: [],
    customFields: [],
    tags: [],
    timestamp: '2026-02-21T00:01:00.000Z',
  };
  const history = {
    head: 'h1',
    commits: [{ hash: 'h1', parent: null, timestamp: '2026-02-21T00:01:00.000Z', changed: [], snapshot }],
  };

  it('HEAD commit has no delta and head_snapshot equals the commit snapshot', () => {
    const compact = serializeHistoryForStorage(history);
    expect(compact.commits[0].delta).toBeUndefined();
    expect(compact.head_snapshot.title).toBe(snapshot.title);
    expect(compact.head_snapshot.password).toBe(snapshot.password);
  });

  it('parseHistoryJson on single-commit compact returns one commit with correct snapshot', () => {
    const compact = serializeHistoryForStorage(history);
    const parsed = parseHistoryJson(compact);
    expect(parsed.commits).toHaveLength(1);
    expect(parsed.commits[0].snapshot.title).toBe(snapshot.title);
    expect(parsed.commits[0].snapshot.password).toBe(snapshot.password);
  });
});

describe('10-commit truncation cap', () => {
  it('drops the 11th (oldest) commit when history exceeds 10 commits', () => {
    const commits = Array.from({ length: 11 }, (_, i) => ({
      hash: `h${11 - i}`,
      parent: i < 10 ? `h${10 - i}` : null,
      timestamp: `2026-02-21T00:${String(i + 1).padStart(2, '0')}:00.000Z`,
      changed: [],
      snapshot: { ...BASE_SNAPSHOT, password: `pw${i}` },
    }));
    const compact = serializeHistoryForStorage({ head: 'h11', commits });
    expect(compact.commits).toHaveLength(10);
    expect(compact.commits.find((c) => c.hash === 'h1')).toBeUndefined();
  });
});
