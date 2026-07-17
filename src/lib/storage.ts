// Path and cap helpers for the single per-entry InstantDB Storage file (see
// docs/crypto.md, Entry Data File). Pure and InstantDB-free so they're
// directly unit-testable.

export function entryFilePath(authId: string, entryId: string, commitHash: string): string {
  return `${authId}/entries/${entryId}/${commitHash}.json`;
}

// `T` is generic only because this is called with both `RawSnapshot[]` (db.ts,
// the actual decrypted commit array) and plain commit-shaped test fixtures
// (storage.test.ts) — the function itself never inspects an element's
// fields, it only slices the array, so it doesn't need to know the real
// element type. The caller must pass the array already sorted newest first;
// this just trims to the oldest-allowed tail, it doesn't sort.
export function capHistoryArray<T>(sortedNewestFirst: T[], cap: number): T[] {
  return sortedNewestFirst.slice(0, cap);
}
