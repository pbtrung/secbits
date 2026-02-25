# Design — SecBits

Architecture decisions and their rationale.

---

## Offline-First, Single Binary

**Decision:** All data lives in a local SQLite file. No server, no sync daemon.

**Why:** The prior app required a live server (Firebase + Turso) to read any entry. A power outage, network partition, or service shutdown made data inaccessible. A local SQLite file works on an air-gapped machine and is trivially backed up.

Single binary simplifies installation — no runtime, no interpreter, no package manager. `cargo install` or a copied binary is enough.

---

## Module Boundaries

| Module           | Owns                                  | Does NOT own                       |
|------------------|---------------------------------------|------------------------------------|
| `crypto.rs`      | leancrypto FFI, HKDF, AEAD, blobs     | business logic, DB I/O             |
| `model.rs`       | history structs, deltas, hashing      | encryption, DB I/O                 |
| `db.rs`          | SQL queries, schema, CRUD             | crypto, business logic             |
| `app.rs`         | command flows, interactive UX         | raw SQL, raw crypto primitives     |
| `config.rs`      | TOML parse, path expansion            | runtime state                      |
| `backup.rs`      | S3 upload/download, blob assembly     | entry crypto (delegates to crypto) |

This strict split keeps each module unit-testable in isolation. `app.rs` is the only module that orchestrates across others.

---

## Ascon-Keccak-512 AEAD

**Decision:** Use leancrypto's Ascon-Keccak-512 with 512-bit key, IV, and tag.

**Why:** The prior app already used this. It is a post-quantum-safe authenticated cipher available in the system-installed `libleancrypto`. Using 512-bit parameters (vs the more common 128-bit) provides a comfortable margin against quantum-accelerated collision search (Grover's algorithm halves effective key length). The 64-byte tag provides 256-bit post-quantum authentication security.

---

## HKDF-SHA3-512 for Key Derivation

**Decision:** Every blob uses a fresh random salt fed through HKDF-SHA3-512 to derive `(encKey, encIv)`.

**Why:** Deriving a unique key+IV pair per blob from a fresh salt means:
1. The same plaintext encrypted twice produces different ciphertext (salt randomises output).
2. IV reuse — a catastrophic AEAD failure mode — is structurally impossible even if the caller reuses a key.
3. No key management overhead: the caller only stores the master key; all per-blob material is disposable.

---

## Per-Entry Doc Key (Key Wrapping)

**Decision:** Each entry has its own 64-byte `doc_key`. The `entry_key` column stores `encryptBytesToBlob(user_master_key, doc_key)`. The `value` column stores `encryptBytesToBlob(doc_key, history)`.

**Why:** If the root master key is rotated (new key wraps the same UMK), only the 192-byte UMK blob needs re-encrypting — not every entry. If a single entry's doc key were somehow leaked, no other entries are affected. The two-level structure mirrors established key-wrapping patterns (e.g., AWS KMS envelope encryption).

---

## Brotli Before Encryption

**Decision:** Compress history JSON with Brotli before encrypting.

**Why:**
1. Encrypted data is indistinguishable from random; compressors cannot find structure in it. Compression after encryption is a no-op.
2. History JSON with repetitive field names compresses well (50–70% reduction typical), reducing DB storage and backup upload size.
3. No timing oracle risk: Brotli compression ratio does not leak secret content in this context because the compressed size is never exposed to an attacker (it's stored in an opaque encrypted blob).

---

## Compact History Object

**Decision:** Store `{ head, head_snapshot, commits[] }` where commits beyond HEAD carry deltas, not full snapshots. Max 10 commits; oldest always has full-snapshot delta.

**Why:**
- `head_snapshot` enables O(1) read of current state — no delta traversal needed for the common case (`show`, `totp`).
- Storing full snapshots for every commit would be redundant and grow unboundedly.
- Capping at 10 commits bounds storage. The oldest commit's full-snapshot delta preserves the ability to reconstruct any retained commit.
- HEAD never carries a delta because its state is always read directly from `head_snapshot`.

---

## SHA-256 for Commit Hash

**Decision:** Commit identity hash = SHA-256 of content JSON (timestamp excluded), first 12 hex chars.

**Why:** Commit hashes serve as stable identifiers for `history` output and `restore --commit`. They are not used for authentication or integrity (AEAD handles that). SHA-256 is faster than SHA3-512 and the 12-hex-char prefix gives 48 bits of collision resistance — more than sufficient for a personal vault that will never exceed thousands of entries.

---

## Pass-Style Path UX

**Decision:** Entries addressed by slash-separated path strings (`mail/google/main`). Fuzzy regex matching with case-smart mode. Ambiguous matches are an error, not a guess.

**Why:** `pass` established this pattern and it is well-understood by developers. Regex matching allows partial-path recall (`mail/g`) without requiring exact strings. Refusing to act on ambiguous matches prevents accidental operations on the wrong entry — the cost of one extra keystroke is less than the risk of editing the wrong entry silently.

---

## S3-Compatible Backups

**Decision:** Backups upload an AEAD-encrypted copy of the raw SQLite file to any S3-compatible endpoint (R2, AWS S3, GCS).

**Why:**
- The SQLite file is the complete ground truth; backing it up verbatim avoids a separate export/import format.
- Encrypting before upload means the storage provider learns nothing about content, key names, or entry counts.
- S3's object listing with ISO-8601 keys gives lexicographic ordering for free, making "latest backup" a simple max-key lookup without a separate metadata store.
- Supporting multiple providers (R2, AWS, GCS) via a single `[targets.<name>]` config table gives flexibility without per-provider code paths — the S3 API is the common denominator.

---

## ML-KEM-1024 + X448 Hybrid KEM for Sharing

**Decision:** Entry sharing uses leancrypto's `lcr_kyber_x448` hybrid KEM.

**Why:**
- **Post-quantum safety**: ML-KEM-1024 (NIST PQC standardized) provides security against quantum adversaries. Both ML-KEM and X448 must be broken simultaneously to compromise confidentiality.
- **Forward secrecy per share**: `encapsulate()` generates a fresh ephemeral X448 scalar for every call. Past shares remain confidential even if the recipient's long-term X448 key is later compromised.
- **No extra dependency**: `lcr_kyber_x448` is already part of `leancrypto-sys`; no additional crate or system library is needed.
- **No history leakage**: only `head_snapshot` is shared. The sender's commit history is never visible to the recipient.
- **Self-contained payloads**: `.sbsh` files are complete encrypted blobs requiring no server. Any channel (file copy, email, S3 relay) works.

See `agent_docs/sharing.md` for the protocol and payload format details.
