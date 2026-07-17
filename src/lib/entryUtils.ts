// Plain data helpers shared by App.tsx and components: entry defaulting/
// normalization, tag/search filtering, entry-type metadata, and deleted-at
// display formatting. No crypto or InstantDB dependency — everything here
// operates on already-decrypted Entry objects.
import type { CustomField, Entry, EntryType } from '../types';

export function formatExact(ts: number): string {
  const d = new Date(ts);
  if (!Number.isFinite(d.getTime())) return 'Unknown date';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export interface DeletedLabel {
  text: string;
  exact: string;
}

export function formatDeletedLabel(ts: number): DeletedLabel {
  const deletedAt = new Date(ts);
  if (!Number.isFinite(deletedAt.getTime())) return { text: 'Deleted', exact: '' };
  const exact = formatExact(ts);
  const now = new Date();
  const dayMs = 24 * 60 * 60 * 1000;
  const startNow = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startDeleted = new Date(deletedAt.getFullYear(), deletedAt.getMonth(), deletedAt.getDate());
  const dayDiff = Math.floor((startNow.getTime() - startDeleted.getTime()) / dayMs);
  const [date, time] = exact.split(' ');
  if (dayDiff >= 0 && dayDiff <= 7) {
    if (dayDiff === 0) return { text: `Deleted today at ${time}`, exact };
    if (dayDiff === 1) return { text: `Deleted yesterday at ${time}`, exact };
    return { text: `Deleted ${dayDiff} days ago at ${time}`, exact };
  }
  return { text: `Deleted on ${date} at ${time}`, exact };
}

interface EntryTypeMeta {
  type: EntryType;
  icon: string;
  label: string;
  desc: string;
}

// Single source of truth for entry type metadata.
// ENTRY_TYPES  — iterate for rendering (dropdown, lists).
// ENTRY_TYPE_META — O(1) lookup by type key.
export const ENTRY_TYPES: EntryTypeMeta[] = [
  { type: 'login', icon: 'bi-person-badge', label: 'Login', desc: 'Username, password, URLs, TOTP' },
  { type: 'note', icon: 'bi-sticky', label: 'Secure Note', desc: 'Encrypted free-form text' },
  { type: 'card', icon: 'bi-credit-card', label: 'Credit Card', desc: 'Card number, expiry, CVV' },
];

export const ENTRY_TYPE_META: Record<EntryType, Pick<EntryTypeMeta, 'icon' | 'label'>> = Object.fromEntries(
  ENTRY_TYPES.map(({ type, icon, label }) => [type, { icon, label }]),
) as Record<EntryType, Pick<EntryTypeMeta, 'icon' | 'label'>>;

// customFields replaced the older `hiddenFields` name; entries saved under
// the old name still need to read as customFields everywhere an entry gets
// normalized.
export function normalizeCustomFields(
  entry: { customFields?: unknown; hiddenFields?: unknown } | null | undefined,
): CustomField[] {
  if (Array.isArray(entry?.customFields)) return entry.customFields;
  if (Array.isArray(entry?.hiddenFields)) return entry.hiddenFields;
  return [];
}

// Fills in defaults for a decrypted entry coming back from db.ts, so every
// caller that puts one into React state gets the same shape regardless of
// which db.ts function produced it. The input is looser than Entry (any
// field may be missing, e.g. an older entry saved before a field existed);
// the cast at the end reflects that id/type/timestamps are always present
// in practice by calling convention, not enforced here.
export function normalizeEntry(e: Partial<Entry>): Entry {
  return {
    title: '',
    username: '',
    password: '',
    notes: '',
    ...e,
    urls: Array.isArray(e.urls) ? e.urls : [],
    totpSecrets: Array.isArray(e.totpSecrets) ? e.totpSecrets : [],
    customFields: normalizeCustomFields(e),
    tags: Array.isArray(e.tags) ? e.tags : [],
  } as Entry;
}

export interface FilterEntriesOptions {
  selectedTag?: string | null;
  searchQuery?: string;
}

/**
 * Filter live entries by tag and/or search query.
 * trashed entries are excluded — callers should not pass trashed entries.
 */
export function filterEntries(
  entries: Entry[],
  { selectedTag = null, searchQuery = '' }: FilterEntriesOptions = {},
): Entry[] {
  let result = entries;
  if (selectedTag) {
    result = result.filter((e) => e.tags.includes(selectedTag));
  }
  if (searchQuery.trim()) {
    const q = searchQuery.toLowerCase();
    result = result.filter(
      (e) =>
        e.title.toLowerCase().includes(q) ||
        (e.username ?? '').toLowerCase().includes(q) ||
        (e.urls ?? []).some((u) => u.toLowerCase().includes(q)),
    );
  }
  return result;
}
