> Part of [Design Docs](../design.md).

# Cryptographic Design

## Key hierarchy

```text
Root Master Key (from config file, >=256 bytes)
    |
    +-- HKDF-SHA3-512 -> encKey (64B) + encIv (64B)
    |
    +-- Ascon-Keccak-512(encKey, encIv, userMasterKey) -> encUserMasterKey + AEAD tag (64B)
    |
    +-- User Master Key (64B, random per user, decrypted at login)
            |
            +-- per-entry doc key (64B, random per entry)
                    |
                    +-- HKDF-SHA3-512 -> encKey (64B) + encIv (64B)
                    +-- JSON -> Brotli compress -> Ascon-Keccak-512 encrypt + AEAD tag
                    +-- stored as Firestore Bytes in value field
```

## Algorithms

| Algorithm | Role | Notes |
|---|---|---|
| Ascon-Keccak-512 AEAD | Authenticated encryption | 512-bit key, 512-bit nonce, 512-bit tag; via leancrypto WASM |
| HKDF-SHA3-512 | Key derivation | Fresh 64-byte salt per encryption; derives 128 bytes (encKey \|\| encIv) |
| Brotli (WASM) | Compression | Applied before encryption |
| TOTP-SHA1 | 2FA code generation | RFC 6238, 30-second window |

## Blob format

Every encrypted value has the same layout:

```text
salt (64B) || ciphertext (N B) || AEAD tag (64B)
```

Total overhead per blob: 128 bytes. The master key blob is always 192 bytes (`salt || encUserMasterKey || tag`).

## Master key flow

**First login (new user):**

1. `decodeRootMasterKey()` validates the base64 root master key from the config file (must decode to >=256 bytes).
2. A random 64-byte User Master Key is generated, then AEAD-encrypted using keys derived via HKDF-SHA3-512 from the root master key.
3. The 192-byte blob (`salt || encUserMasterKey || tag`) is written to `users/{userId}/user_master_key` in Firestore.
4. The plaintext User Master Key is kept in memory for the rest of the session.

**Returning user:**

1. The stored 192-byte blob is fetched from Firestore.
2. HKDF-SHA3-512 re-derives encKey and encIv from the root master key and the stored salt.
3. Ascon-Keccak-512 AEAD decryption verifies the tag and recovers the User Master Key. A wrong root master key causes authentication failure here.
4. The User Master Key is kept in memory for the session.

## Entry encryption

Each entry stores a commit chain (up to 10 commits). On every save the history object is serialised, compressed, and encrypted:

```text
{ head, head_snapshot, commits[] }  ->  JSON.stringify  ->  Brotli compress
    ->  Ascon-Keccak-512 AEAD encrypt (with entry's doc key)
    ->  AEAD tag appended
    ->  stored as Firestore Bytes in value field
```

The entry's doc key is itself AEAD-encrypted using the `userMasterKey` and stored in the `entry_key` field of the same Firestore document.

## Commit structure

Each commit object inside the history has the following shape:

```json
{
  "hash":      "a1b2c3d4e5f6",
  "parent":    "f7e8d9c0b1a2",
  "timestamp": "2025-06-01T14:32:00Z",
  "changed":   ["password"]
}
```

| Field | Description |
|---|---|
| `hash` | SHA-256 of the snapshot content (timestamp excluded), truncated to 12 hex chars |
| `parent` | Hash of the preceding commit; `null` for the initial commit |
| `timestamp` | ISO-8601 wall-clock time of the save |
| `changed` | Fields that differ from the previous commit (`title`, `password`, `notes`, etc.) |

The `head` field at the top of the history object always points to the most recent commit hash.

## Compact history storage format

To reduce Firestore payload size, only the latest snapshot is stored in full:

```json
{
  "head": "a1b2c3d4e5f6",
  "head_snapshot": { "title": "…", "username": "…", "password": "…", "notes": "…", "...": "..." },
  "commits": [
    { "hash": "a1b2c3d4e5f6", "parent": "f7e8d9c0b1a2", "timestamp": "2025-06-01T14:32:00Z", "changed": ["password"] },
    { "hash": "f7e8d9c0b1a2", "parent": null, "timestamp": "2025-05-31T10:00:00Z", "changed": [], "delta": { "set": { "password": "old" }, "unset": [] } }
  ]
}
```

- `head_snapshot` stores the full plaintext snapshot for HEAD.
- `commits[0]` stores HEAD commit metadata.
- Older commits store `delta` (`set`/`unset`) relative to the newer snapshot above them.
- Snapshots are reconstructed in memory at read time for diff and restore.
- Only this compact format is supported.

**Deduplication.** Before appending a new commit, the hash of the incoming content (fields only, no timestamp) is compared to the current `head` hash. If they match the save is a no-op and no commit is written.

**Restore.** Restoring an old commit creates a new HEAD commit whose snapshot is the old snapshot with a fresh timestamp. History is extended, never overwritten.
