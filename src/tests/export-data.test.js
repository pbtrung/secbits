import { describe, expect, it } from 'vitest';
import { buildExportData } from '../lib/api.js';

describe('buildExportData', () => {
  it('returns canonical export payload shape', () => {
    const exportData = buildExportData({
      username: 'alice',
      entries: [{ id: 'e1', title: 'example' }],
      trash: [{ id: 't1', title: 'deleted', deletedAt: '2026-02-26T00:00:00.000Z' }],
    });

    expect(exportData).toMatchObject({
      version: 1,
      username: 'alice',
      data: [{ id: 'e1', title: 'example' }],
      trash: [{ id: 't1', title: 'deleted' }],
    });
  });

  it('live entries have no deleted_at field', () => {
    const entry = { id: 'e1', title: 'live', type: 'login', tags: [] };
    const { data } = buildExportData({ username: 'u', entries: [entry], trash: [] });
    expect(data[0].deleted_at).toBeUndefined();
  });

  it('trashed entries preserve deletedAt', () => {
    const trashed = { id: 't1', title: 'gone', deletedAt: '2026-01-10T00:00:00.000Z' };
    const { trash } = buildExportData({ username: 'u', entries: [], trash: [trashed] });
    expect(trash[0].deletedAt).toBe('2026-01-10T00:00:00.000Z');
  });

  it('empty vault returns empty arrays', () => {
    const { data, trash } = buildExportData({ username: 'u', entries: [], trash: [] });
    expect(data).toEqual([]);
    expect(trash).toEqual([]);
  });

  it('export preserves decrypted fields on entries', () => {
    const entry = {
      id: 'e1',
      type: 'login',
      title: 'My Bank',
      username: 'alice',
      password: 's3cr3t',
      notes: 'important',
      urls: ['https://bank.example.com'],
      totpSecrets: ['JBSWY3DP'],
      customFields: [{ id: 1, label: 'pin', value: '1234' }],
      tags: ['finance', 'important'],
      _commits: [{ hash: 'abc123', parent: null, timestamp: '2026-01-01T00:00:00.000Z', changed: [], snapshot: {} }],
    };
    const { data } = buildExportData({ username: 'u', entries: [entry], trash: [] });
    const exported = data[0];
    expect(exported.type).toBe('login');
    expect(exported.title).toBe('My Bank');
    expect(exported.username).toBe('alice');
    expect(exported.tags).toEqual(['finance', 'important']);
    expect(exported._commits).toHaveLength(1);
  });

  it('export includes all live and all trashed entries', () => {
    const live = [
      { id: 'e1', title: 'one' },
      { id: 'e2', title: 'two' },
    ];
    const trashed = [{ id: 't1', title: 'deleted', deletedAt: '2026-01-01T00:00:00.000Z' }];
    const result = buildExportData({ username: 'u', entries: live, trash: trashed });
    expect(result.data).toHaveLength(2);
    expect(result.trash).toHaveLength(1);
  });
});
