import { describe, expect, it } from 'vitest';
import { fieldsChanged, stripNestedHistory, buildCommitList, getVaultStats, buildExportData } from '../db.js';

describe('fieldsChanged', () => {
  it('returns only the diffable fields that actually differ', () => {
    const from = {
      title: 'a',
      username: 'u',
      password: 'p',
      notes: 'n',
      urls: [],
      totpSecrets: [],
      tags: [],
      customFields: [],
      createdAt: 1,
    };
    const to = { ...from, title: 'b', createdAt: 2 };
    expect(fieldsChanged(from, to)).toEqual(['title']);
  });

  it('ignores non-diffable fields like createdAt/updatedAt/commitHash', () => {
    const from = { title: 'a', createdAt: 1, updatedAt: 1, commitHash: 'x' };
    const to = { title: 'a', createdAt: 2, updatedAt: 2, commitHash: 'y' };
    expect(fieldsChanged(from, to)).toEqual([]);
  });

  it('detects array field changes via deep comparison', () => {
    const from = { tags: ['a', 'b'] };
    const to = { tags: ['a', 'c'] };
    expect(fieldsChanged(from, to)).toEqual(['tags']);
  });
});

type RawSnapshotArg = Parameters<typeof stripNestedHistory>[0];
type RawSnapshotListArg = Parameters<typeof buildCommitList>[0];

describe('stripNestedHistory', () => {
  it('removes a nested history key while preserving everything else', () => {
    const snap = { id: '1', title: 'x', history: [{ id: 'stale' }] } as unknown as RawSnapshotArg;
    expect(stripNestedHistory(snap)).toEqual({ id: '1', title: 'x' });
  });

  it('is a no-op when there is no history key', () => {
    const snap = { id: '1', title: 'x' } as unknown as RawSnapshotArg;
    expect(stripNestedHistory(snap)).toEqual(snap);
  });
});

describe('buildCommitList', () => {
  it('wires parent/changed correctly across a chain, oldest has no parent, and strips nested history', () => {
    const newest = { id: 'c3', commitHash: 'h3', updatedAt: 300, title: 'v3', history: [{ id: 'stale' }] };
    const middle = { id: 'c2', commitHash: 'h2', updatedAt: 200, title: 'v2' };
    const oldest = { id: 'c1', commitHash: 'h1', createdAt: 100, title: 'v1' };
    const list = buildCommitList([newest, middle, oldest] as unknown as RawSnapshotListArg);

    expect(list).toHaveLength(3);
    expect(list[0]).toMatchObject({ hash: 'h3', timestamp: 300, parent: 'h2', changed: ['title'] });
    expect(list[0].snapshot).not.toHaveProperty('history');
    expect(list[1]).toMatchObject({ hash: 'h2', timestamp: 200, parent: 'h1', changed: ['title'] });
    expect(list[2]).toMatchObject({ hash: 'h1', timestamp: 100, parent: null, changed: undefined });
  });
});

type EntryArg = Parameters<typeof getVaultStats>[0][number];
type BuildExportDataArg = Parameters<typeof buildExportData>[0];

describe('getVaultStats', () => {
  it('counts entries, trash, and unique tags', () => {
    const entries = [{ tags: ['work', 'personal'] }, { tags: ['work'] }, { tags: [] }] as unknown as EntryArg[];
    const trash = [{}, {}] as unknown as EntryArg[];
    expect(getVaultStats(entries, trash)).toEqual({ entryCount: 3, trashCount: 2, tagCount: 2 });
  });
});

describe('buildExportData', () => {
  it("filters the current version out of each entry's exported history", () => {
    const entry = {
      id: 'e1',
      commitHash: 'current',
      history: [
        { hash: 'current', snapshot: {} },
        { hash: 'older', snapshot: {} },
      ],
    };
    const result = buildExportData({
      username: 'jane',
      entries: [entry],
      trash: [],
    } as unknown as BuildExportDataArg);
    expect(result.data[0].history).toEqual([{ hash: 'older', snapshot: {} }]);
  });

  it('produces the versioned export shape', () => {
    const result = buildExportData({ username: 'jane', entries: [], trash: [] });
    expect(result).toEqual({ version: 1, username: 'jane', user_master_key: null, data: [], trash: [] });
  });

  it('sets entry_key to null when the entry key cache has no entry for this id', () => {
    const entry = { id: 'unknown-id', history: [] };
    const result = buildExportData({
      username: 'jane',
      entries: [entry],
      trash: [],
    } as unknown as BuildExportDataArg);
    expect(result.data[0].entry_key).toBeNull();
  });
});
