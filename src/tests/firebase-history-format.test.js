import { describe, expect, it } from 'vitest';
import { __historyFormatTestOnly } from '../firebase.js';

const { parseHistoryJson, serializeHistoryForStorage } = __historyFormatTestOnly;

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

  it('parses legacy snapshot-based histories', () => {
    const legacy = {
      head: 'h2',
      commits: [
        {
          hash: 'h2',
          parent: 'h1',
          timestamp: '2026-02-21T00:02:00.000Z',
          changed: ['hiddenFields'],
          snapshot: {
            title: 'entry',
            username: '',
            password: '',
            notes: '',
            urls: [],
            totpSecrets: [],
            hiddenFields: [{ id: 1, label: 'token', value: 'abc' }],
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

    const parsed = parseHistoryJson(legacy);
    expect(parsed.head).toBe('h2');
    expect(parsed.commits).toHaveLength(2);
    expect(parsed.commits[0].changed).toEqual(['customFields']);
    expect(parsed.commits[0].snapshot.customFields).toEqual([{ id: 1, label: 'token', value: 'abc' }]);
  });
});
