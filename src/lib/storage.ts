// Path and cap helpers for the single per-entry InstantDB Storage file (see
// docs/crypto.md, Entry Data File). Pure and InstantDB-free so they're
// directly unit-testable.

export function entryFilePath(authId: string, entryId: string, commitHash: string): string {
  return `${authId}/entries/${entryId}/${commitHash}.json`;
}

export function capHistoryArray<T>(sortedNewestFirst: T[], cap: number): T[] {
  return sortedNewestFirst.slice(0, cap);
}
