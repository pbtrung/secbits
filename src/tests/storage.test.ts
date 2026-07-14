import { describe, expect, it } from 'vitest';
import { capHistoryArray, entryFilePath } from '../lib/storage';

describe('entryFilePath', () => {
  it('namespaces by auth id, entry id, and commit hash', () => {
    expect(entryFilePath('user1', 'entryA', 'abc123')).toBe('user1/entries/entryA/abc123.json');
  });

  it('produces a different path for a different commit hash', () => {
    const a = entryFilePath('user1', 'entryA', 'abc123');
    const b = entryFilePath('user1', 'entryA', 'def456');
    expect(a).not.toBe(b);
  });
});

describe('capHistoryArray', () => {
  it('returns the array unchanged when under the cap', () => {
    const arr = [1, 2, 3];
    expect(capHistoryArray(arr, 20)).toEqual([1, 2, 3]);
  });

  it('returns the array unchanged when exactly at the cap', () => {
    const arr = Array.from({ length: 20 }, (_, i) => i);
    expect(capHistoryArray(arr, 20)).toEqual(arr);
  });

  it('drops the oldest (tail) entries past the cap', () => {
    const arr = Array.from({ length: 25 }, (_, i) => i); // newest-first: 0..24
    const capped = capHistoryArray(arr, 20);
    expect(capped).toHaveLength(20);
    expect(capped).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });
});
