import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  formatExact,
  formatDeletedLabel,
  normalizeCustomFields,
  normalizeEntry,
  ENTRY_TYPES,
  ENTRY_TYPE_META,
} from '../lib/entryUtils.js';

describe('formatExact', () => {
  it('formats a known timestamp as DD/MM/YYYY HH:MM:SS in local time', () => {
    const d = new Date(2026, 6, 10, 14, 5, 9); // 10 Jul 2026, 14:05:09 local
    expect(formatExact(d.getTime())).toBe('10/07/2026 14:05:09');
  });

  it('returns "Unknown date" for an invalid timestamp', () => {
    expect(formatExact(NaN)).toBe('Unknown date');
    expect(formatExact(undefined)).toBe('Unknown date');
    expect(formatExact('not a date')).toBe('Unknown date');
  });
});

describe('formatDeletedLabel', () => {
  const NOW = new Date(2026, 6, 10, 12, 0, 0); // 10 Jul 2026, noon local

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('labels a deletion from today', () => {
    const ts = new Date(2026, 6, 10, 9, 30, 0).getTime();
    expect(formatDeletedLabel(ts).text).toBe('Deleted today at 09:30:00');
  });

  it('labels a deletion from yesterday', () => {
    const ts = new Date(2026, 6, 9, 9, 30, 0).getTime();
    expect(formatDeletedLabel(ts).text).toBe('Deleted yesterday at 09:30:00');
  });

  it('labels a deletion 2-7 days ago with the day count', () => {
    const ts = new Date(2026, 6, 6, 9, 30, 0).getTime(); // 4 days before NOW
    expect(formatDeletedLabel(ts).text).toBe('Deleted 4 days ago at 09:30:00');
  });

  it('labels an older deletion with the full date, not a relative count', () => {
    const ts = new Date(2026, 5, 1, 9, 30, 0).getTime(); // well over a month before NOW
    expect(formatDeletedLabel(ts).text).toBe('Deleted on 01/06/2026 at 09:30:00');
  });

  it('returns a fallback for an invalid timestamp', () => {
    expect(formatDeletedLabel(NaN)).toEqual({ text: 'Deleted', exact: '' });
  });
});

describe('normalizeCustomFields', () => {
  it('passes through an existing customFields array', () => {
    const entry = { customFields: [{ label: 'PIN', value: '1234' }] };
    expect(normalizeCustomFields(entry)).toBe(entry.customFields);
  });

  it('reads the legacy hiddenFields array when customFields is absent', () => {
    const entry = { hiddenFields: [{ label: 'PIN', value: '1234' }] };
    expect(normalizeCustomFields(entry)).toBe(entry.hiddenFields);
  });

  it('returns an empty array when neither is present', () => {
    expect(normalizeCustomFields({})).toEqual([]);
    expect(normalizeCustomFields(null)).toEqual([]);
  });
});

describe('normalizeEntry', () => {
  it('fills in string and array defaults for a bare entry', () => {
    expect(normalizeEntry({})).toEqual({
      title: '', username: '', password: '', notes: '',
      urls: [], totpSecrets: [], customFields: [], tags: [],
    });
  });

  it('preserves existing fields rather than overwriting them', () => {
    const entry = {
      type: 'login',
      title: 'GitHub', username: 'alice', password: 'p', notes: 'n',
      urls: ['https://github.com'], totpSecrets: ['SEED'], tags: ['work'],
      customFields: [{ label: 'PIN', value: '1234' }],
    };
    expect(normalizeEntry(entry)).toEqual(entry);
  });

  it('reads legacy hiddenFields as customFields', () => {
    const entry = { hiddenFields: [{ label: 'PIN', value: '1' }] };
    expect(normalizeEntry(entry).customFields).toEqual(entry.hiddenFields);
  });
});

describe('ENTRY_TYPE_META', () => {
  it('is derived from ENTRY_TYPES for every type, guarding the two lists against drifting apart', () => {
    for (const { type, icon, label } of ENTRY_TYPES) {
      expect(ENTRY_TYPE_META[type]).toEqual({ icon, label });
    }
    expect(Object.keys(ENTRY_TYPE_META)).toHaveLength(ENTRY_TYPES.length);
  });
});
