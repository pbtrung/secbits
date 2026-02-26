import { describe, expect, it } from 'vitest';
import { buildExportData } from '../api.js';

describe('buildExportData', () => {
  it('returns canonical export payload shape', () => {
    const exportData = buildExportData({
      username: 'alice',
      entries: [{ id: 'e1', title: 'example' }],
    });

    expect(exportData).toMatchObject({
      version: 1,
      username: 'alice',
      data: [{ id: 'e1', title: 'example' }],
    });
  });
});
