# Design

Architectural decisions and their rationale.

## Firebase Auth + CF Worker + CF Pages + rqlite

**Decision:** Firebase Authentication issues identity tokens; a Cloudflare Worker verifies tokens and mediates all database access; Cloudflare Pages hosts the static frontend; rqlite stores encrypted entry rows over HTTP with Basic Auth.

**Why:** Each layer has a single bounded responsibility. Firebase handles credential management and token issuance without the Worker needing to store passwords or issue its own tokens. The Worker is a thin auth-enforcement and database gateway — it never handles plaintext. rqlite stores opaque encrypted blobs per entry row. Cloudflare Pages provides globally distributed static hosting that integrates cleanly with a Cloudflare Worker origin. rqlite is lightweight, self-hostable, and exposes a familiar SQLite model over a simple HTTP API.

## Per-Entry Encryption

**Decision:** Each entry is encrypted as an independent blob. The Worker stores one ciphertext blob per entry row in rqlite. Create and update operations encrypt only the affected entry, not the entire vault.

**Why:** Per-entry encryption enables incremental writes — only the modified entry needs re-encryption and re-upload on each save. History commits are independent encrypted blobs stored as individual rows in `entry_history`. Fetching one entry's history does not require downloading the full vault. This scales better with large vaults and makes the read and write paths symmetric and entry-scoped.

## rqlite for Structured Entry Storage

**Decision:** All entries and their history commits are stored as rows in rqlite. Trash is represented by a nullable `deleted_at` column on the `entries` table rather than a separate store.

**Why:** A relational schema lets the Worker filter entries by `vault_id`, query live and trashed entries with a single predicate, and manage history commits with row-level insert and delete. Per-entry row storage means the database holds structured metadata (entry ID, type, timestamps, deletion state) alongside the opaque encrypted blob — enabling efficient queries without the client downloading everything to perform filtering. rqlite exposes standard SQLite semantics over HTTP, so queries use parameterized SQL and the Worker needs no SQL driver or native binding.

## rqlite Credentials as Worker Secrets

**Decision:** The rqlite HTTP endpoint URL, Basic Auth username, and Basic Auth password are stored as Cloudflare Worker secrets (`RQLITE_URL`, `RQLITE_USERNAME`, `RQLITE_PASSWORD`). The browser has no knowledge of these values.

**Why:** The browser communicates only with the Worker using Firebase ID tokens. Exposing rqlite credentials to the client would allow any authenticated user to query or mutate any row in the database directly, bypassing the Worker's auth enforcement and vault_id scoping. Keeping credentials in Worker secrets means rqlite is only reachable through the Worker's auth-enforced API.

## vault_id for Auth-Independent Scoping

**Decision:** All entry rows are scoped to a `vault_id` column supplied from the client config JSON. The Worker enforces that every query filters by the authenticated user's `vault_id`. `vault_id` is a secret random string in the config, alongside the root master key.

**Why:** Tying the storage namespace to the auth provider identity (e.g. Firebase UID) would couple storage layout to the auth layer. A stable config-supplied `vault_id` keeps the namespace consistent across auth changes or provider migrations without requiring data migration. It also functions as an additional access control layer: a client without the config cannot determine which rows belong to a given vault. The Worker verifies the Firebase token on every request before using the client-supplied `vault_id` to scope queries.

## Ascon-Keccak-512 AEAD

**Decision:** All encryption uses leancrypto's Ascon-Keccak-512 AEAD with 512-bit key, IV, and tag.

**Why:** Grover's algorithm halves the effective key length of symmetric ciphers on a quantum computer. 512-bit parameters retain 256-bit post-quantum security margins uniformly across key, IV, and tag. The leancrypto WASM bundle ships with the app, so no additional network dependency is introduced.

## HKDF-SHA3-512 with Per-Blob Fresh Salt

**Decision:** Every encryption derives a unique `(encKey, encIv)` pair from a fresh 64-byte random salt via HKDF-SHA3-512.

**Why:** IV reuse under the same AEAD key is catastrophic — identical `(key, IV)` on two encryptions exposes the XOR of both plaintexts. Per-blob salt derivation makes IV reuse structurally impossible: the caller stores only the static root master key; all per-blob key material is ephemeral and never stored.

## Blob Format with Versioned Magic Header

**Decision:** Every encrypted blob is prefixed with a 9-byte header: 7-byte magic (`SecBits` UTF-8) and a 2-byte version (`major · minor`). The full header and salt are passed as AEAD additional data so the tag covers the entire blob.

**Why (magic bytes):** The magic bytes allow any tool or the app itself to immediately identify a SecBits blob in a hex dump or from raw rqlite data, and to fast-fail with a clear error when handed the wrong binary rather than producing a misleading decryption error.

**Why (version field):** The blob format may need to evolve. Without a version field there is no in-band signal to branch on at decode time. Two bytes (major · minor) provide 256 distinct values per component.

**Why (authenticated additional data):** Binding the magic, version, and salt into the AEAD additional data means any modification to any byte in the header causes tag verification to fail, making the full blob tamper-evident.

## Brotli Compression Before Encryption

**Decision:** Entry JSON is Brotli-compressed before AEAD encryption.

**Why:** Encrypted data is statistically indistinguishable from random; a compressor finds no structure in ciphertext. Compressing before encryption takes advantage of the highly repetitive field names in entry JSON and achieves meaningful size reduction. The compressed size is hidden inside the AEAD envelope and unobservable to an attacker.

## Firebase RS256 Token Verification at the Worker

**Decision:** The Worker verifies Firebase ID tokens using Firebase's public JWK endpoint. No external call is made on the authenticated request path after initial key caching.

**Why:** RS256 tokens are self-contained and verifiable by any party with the issuer's public keys. The Worker fetches and caches Firebase's JWK set, then verifies the signature, expiry, and audience locally on every request. This avoids a synchronous call to Firebase on the critical path and does not require a shared secret between the Worker and Firebase.

## In-Memory-Only Session

**Decision:** The root master key, Firebase token, and all decrypted entry data are held only in React component state (JS heap). Nothing is written to `localStorage`, `sessionStorage`, cookies, or IndexedDB.

**Why:** Any persistent browser storage API keeps keying material alive beyond the user's intended session. Holding everything in the JS heap means a hard reload, tab close, or explicit logout clears all secrets immediately and reliably. This also limits the XSS exposure window to the active page lifetime.

## Typed Entries

**Decision:** Every entry carries a `type` field with one of three values: `"login"`, `"note"`, `"card"`. The type is selected at creation, stored in the `entries` row as a plaintext column and within the encrypted blob, and determines which fields are shown in the editor and detail view.

**Why:** Displaying every possible field for all entries produces a noisy, context-free form. Typed entries surface only the fields meaningful for the selected credential kind. The `type` column is also stored in plaintext in rqlite so the Worker can return typed metadata without decrypting anything — but the actual field values remain inside the ciphertext.

## UUID Entry IDs

**Decision:** New persisted entries are assigned IDs with `crypto.randomUUID()`.

**Why:** Native UUID generation is collision-resistant for this use case, avoids custom ID schemes, and keeps ID generation logic auditable.

## Per-Entry History in rqlite

**Decision:** Each history commit is a row in the `entry_history` table containing an independently encrypted full snapshot of the entry at that point. The row carries a `commit_hash` (32-hex-character SHA-256 truncation of the plaintext snapshot, computed before encryption) and a creation timestamp. History is capped at 20 commits per entry; the oldest commit is deleted when the cap is exceeded.

**Why:** Storing history commits as individual rows in the database lets the Worker retrieve history for a single entry without downloading the full vault. Full snapshots per commit are simpler than deltas and eliminate the need to replay a commit chain to reconstruct a past state. The commit hash is computed over the plaintext so it remains a stable content-addressable identifier that can be verified after decryption.
