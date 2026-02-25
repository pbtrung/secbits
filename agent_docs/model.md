# Entry Model — SecBits

## EntrySnapshot Fields

```json
{
  "title": "string",
  "username": "string",
  "password": "string",
  "notes": "string",
  "urls": ["string"],
  "totpSecrets": ["string"],
  "customFields": [{"id": 1, "label": "string", "value": "string"}],
  "tags": ["string"],
  "timestamp": "ISO-8601"
}
```

Tracked for change detection: `title`, `username`, `password`, `notes`, `urls`, `totpSecrets`, `customFields`, `tags`.

## History Object (stored in `entries.value` after brotli + AEAD)

```json
{
  "head": "a1b2c3d4e5f6",
  "head_snapshot": { "...": "..." },
  "commits": [
    { "hash": "a1b2c3d4e5f6", "parent": "f7e8d9c0b1a2", "timestamp": "...", "changed": ["password"] },
    { "hash": "f7e8d9c0b1a2", "parent": null, "timestamp": "...", "changed": ["password", "title"],
      "delta": { "set": { "password": "old", "title": "old" }, "unset": [] } }
  ]
}
```

## Commit Rules

1. `commits[0]` = HEAD. Never has `delta` field; current state always read from `head_snapshot`.
2. Commits at index 1+ carry `delta`. `delta.set` = complete field values in that commit. `delta.unset` = absent/empty fields.
3. Oldest commit (index -1, `parent: null`) carries full-snapshot delta (reconstruction baseline).
4. Max commits = 10. On overflow: drop oldest (FIFO), reconstruct full snapshot at new oldest, update its `delta.set`.

## Commit Hash

SHA-256 of content JSON (timestamp excluded), first 12 hex chars. Computed via `content_hash()` in `model.rs`.

## Dedup

If `content_hash(new_snapshot) == history.head`, no-op (no commit appended).

## Restore Flow

1. `restore_to_commit(history, hash)`:
   - If `hash == head`, return false (already at target).
   - Reconstruct target snapshot by applying deltas backward from `head_snapshot`.
   - Call `append_snapshot(history, reconstructed)` with fresh timestamp.
   - Returns false if hash equals current head (dedup).

## Delta Construction

`full_delta_from_snapshot(snapshot)`: walks all fields, puts non-empty into `set`, empty into `unset`.

`apply_delta_to_snapshot(snapshot, delta)`: applies `set` overwrites and `unset` clears to a JSON object.

## Semantic Diff (normalize_for_compare)

- `tags`: case-insensitive set comparison.
- `urls`: lowercase + strip trailing slash, set comparison.
- `totpSecrets`: set comparison.
- Others: direct equality.

## Single-Commit History

Initial commit has `delta: None`. Delta is set when a second commit is appended (the second commit sets delta on the now-second entry, which was previously HEAD).
