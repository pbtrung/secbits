export function formatExact(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function formatDeletedLabel(ts) {
  const deletedAt = new Date(ts);
  if (!Number.isFinite(deletedAt.getTime())) return { text: 'Deleted', exact: '' };
  const exact = formatExact(ts);
  const now = new Date();
  const dayMs = 24 * 60 * 60 * 1000;
  const startNow    = new Date(now.getFullYear(),     now.getMonth(),     now.getDate());
  const startDeleted = new Date(deletedAt.getFullYear(), deletedAt.getMonth(), deletedAt.getDate());
  const dayDiff = Math.floor((startNow - startDeleted) / dayMs);
  const [date, time] = exact.split(' ');
  if (dayDiff >= 0 && dayDiff <= 7) {
    if (dayDiff === 0) return { text: `Deleted today at ${time}`, exact };
    if (dayDiff === 1) return { text: `Deleted yesterday at ${time}`, exact };
    return { text: `Deleted ${dayDiff} days ago at ${time}`, exact };
  }
  return { text: `Deleted on ${date} at ${time}`, exact };
}

// Single source of truth for entry type metadata.
// ENTRY_TYPES  — iterate for rendering (dropdown, lists).
// ENTRY_TYPE_META — O(1) lookup by type key.
export const ENTRY_TYPES = [
  { type: 'login', icon: 'bi-person-badge', label: 'Login',       desc: 'Username, password, URLs, TOTP' },
  { type: 'note',  icon: 'bi-sticky',       label: 'Secure Note', desc: 'Encrypted free-form text'       },
  { type: 'card',  icon: 'bi-credit-card',  label: 'Credit Card', desc: 'Card number, expiry, CVV'       },
];

export const ENTRY_TYPE_META = Object.fromEntries(
  ENTRY_TYPES.map(({ type, icon, label }) => [type, { icon, label }])
);

/**
 * Filter live entries by tag and/or search query.
 * trashed entries are excluded — callers should not pass trashed entries.
 */
export function filterEntries(entries, { selectedTag = null, searchQuery = '' } = {}) {
  let result = entries;
  if (selectedTag) {
    result = result.filter((e) => e.tags.includes(selectedTag));
  }
  if (searchQuery.trim()) {
    const q = searchQuery.toLowerCase();
    result = result.filter(
      (e) =>
        e.title.toLowerCase().includes(q) ||
        e.username.toLowerCase().includes(q) ||
        e.urls.some((u) => u.toLowerCase().includes(q)),
    );
  }
  return result;
}
