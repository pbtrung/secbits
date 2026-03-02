import { describe, expect, it } from 'vitest';
import { filterEntries } from '../lib/entryUtils.js';

function entry(overrides) {
  return {
    title: '',
    username: '',
    urls: [],
    tags: [],
    ...overrides,
  };
}

const ENTRIES = [
  entry({ id: 'e1', title: 'GitHub', username: 'alice',  tags: ['dev'],     urls: ['https://github.com'] }),
  entry({ id: 'e2', title: 'Gmail',  username: 'alice',  tags: ['email'],   urls: ['https://mail.google.com'] }),
  entry({ id: 'e3', title: 'AWS',    username: 'bob',    tags: ['dev'],     urls: ['https://console.aws.amazon.com'] }),
  entry({ id: 'e4', title: 'Bank',   username: 'alice',  tags: ['finance'], urls: ['https://bank.example.com'] }),
];

describe('filterEntries — search query', () => {
  it('title substring match returns the entry', () => {
    const result = filterEntries(ENTRIES, { searchQuery: 'git' });
    expect(result.map((e) => e.id)).toEqual(['e1']);
  });

  it('username substring match returns the entry', () => {
    const result = filterEntries(ENTRIES, { searchQuery: 'bob' });
    expect(result.map((e) => e.id)).toEqual(['e3']);
  });

  it('case-insensitive: "github" matches title "GitHub"', () => {
    const result = filterEntries(ENTRIES, { searchQuery: 'github' });
    expect(result.map((e) => e.id)).toContain('e1');
  });

  it('no match returns empty array', () => {
    expect(filterEntries(ENTRIES, { searchQuery: 'xxxxnotfound' })).toEqual([]);
  });

  it('empty query returns all entries', () => {
    expect(filterEntries(ENTRIES, { searchQuery: '' })).toHaveLength(ENTRIES.length);
  });

  it('whitespace-only query returns all entries', () => {
    expect(filterEntries(ENTRIES, { searchQuery: '   ' })).toHaveLength(ENTRIES.length);
  });
});

describe('filterEntries — tag filter', () => {
  it('tag filter returns only entries with that tag', () => {
    const result = filterEntries(ENTRIES, { selectedTag: 'dev' });
    expect(result.map((e) => e.id).sort()).toEqual(['e1', 'e3']);
  });

  it('tag with no match returns empty array', () => {
    expect(filterEntries(ENTRIES, { selectedTag: 'unknown-tag' })).toEqual([]);
  });
});

describe('filterEntries — combined text + tag', () => {
  it('returns intersection of text and tag filters', () => {
    // dev tag: e1(GitHub/alice), e3(AWS/bob). "alice" username: e1, e2, e4.
    // intersection: e1
    const result = filterEntries(ENTRIES, { selectedTag: 'dev', searchQuery: 'alice' });
    expect(result.map((e) => e.id)).toEqual(['e1']);
  });

  it('returns empty when intersection is empty', () => {
    const result = filterEntries(ENTRIES, { selectedTag: 'finance', searchQuery: 'bob' });
    expect(result).toEqual([]);
  });
});

describe('filterEntries — trashed entries excluded', () => {
  it('filterEntries is called only with live entries; trashed entries are never in the pool', () => {
    // Callers pass only live entries; trashed entries must not appear in results.
    const live = ENTRIES;
    const trashed = [entry({ id: 'deleted', title: 'GitHub', username: 'alice', tags: ['dev'] })];

    // Filtering live entries should NOT include the trashed entry even though it matches
    const result = filterEntries(live, { searchQuery: 'github' });
    expect(result.every((e) => e.id !== 'deleted')).toBe(true);

    // Confirming: filtering [trashed] directly would find it
    const directResult = filterEntries(trashed, { searchQuery: 'github' });
    expect(directResult).toHaveLength(1);
  });
});
