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
});
