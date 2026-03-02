# Design

Architectural decisions and their rationale.

## Firebase Auth + CF Worker + CF Pages + rqlite

**Decision:** Firebase Authentication issues identity tokens; a Cloudflare Worker verifies tokens and mediates all database access; Cloudflare Pages hosts the static frontend; rqlite stores encrypted rows over HTTP with Basic Auth.

**Why:** Each layer has a single bounded responsibility. Firebase handles credential management and token issuance without the Worker needing to store passwords or issue its own tokens. The Worker is a thin auth-enforcement and database gateway — it never handles plaintext. rqlite stores opaque encrypted blobs as rows in a relational schema. Cloudflare Pages provides globally distributed static hosting that integrates cleanly with a Cloudflare Worker origin. rqlite is lightweight, self-hostable, and exposes standard SQLite semantics over a simple HTTP API.

## User Identity via SHA3-256 z-base-32

**Decision:** The Worker derives a stable `user_id` from the verified Firebase UID: `user_id = z-base-32(SHA3-256(firebase_uid))`. This is the primary key for all user-scoped queries. On the first authenticated request the Worker upserts a row into `users` to register the account.

**Why:** Deriving `user_id` from the Firebase UID at the Worker means the client supplies no namespace identifier. The derivation is deterministic and collision-resistant (SHA3-256 is a one-way function over the UID). z-base-32 encoding produces a compact, URL-safe, case-insensitive 52-character string that is human-readable in logs and database dumps without any ambiguous characters.

## Per-Entry Encryption with Entry Key Wrapping

**Decision:** Each entry has a dedicated 64-byte random key (`entry_key`) generated at creation. The `entry_key` is AEAD-encrypted with the user master key (UMK) and stored in `entries.entry_key`. All entry data blobs and history snapshot blobs for that entry are encrypted with the `entry_key` via HKDF-SHA3-512 + AEAD.

**Why:** A per-entry key creates a three-level hierarchy (root_master_key → UMK → entry_key) where each level can rotate independently. Rotating the root master key requires re-encrypting only the `key_store` row holding the UMK. Rotating the UMK requires re-encrypting all `entry_key` blobs but leaves all entry data and history snapshots untouched. This keeps rotation operations bounded and fast regardless of vault size.

## rqlite for Structured Storage

**Decision:** Entries, history commits, users, key records, and key type constraints are all stored as rows in rqlite. Trash is a nullable `deleted_at` column on `entries`. History is capped at 20 rows per entry.

**Why:** A relational schema lets the Worker scope all queries to a `user_id`, manage entry and history rows independently, and enforce referential integrity between tables. Per-entry row storage enables incremental writes — only the modified entry row is updated on save. rqlite uses parameterized SQL over HTTP, so the Worker needs no native database driver and all queries are injection-safe by construction.

## key_types Lookup Table

**Decision:** A `key_types` table lists the five valid key type identifiers (`umk`, `emergency`, `own_public`, `own_private`, `peer_public`). The `key_store.type` column references it as a foreign key.

**Why:** Storing the valid set of key types in the database lets SQLite enforce the constraint at the storage layer rather than relying solely on Worker-side validation. It also makes the schema self-documenting: any query against `key_types` shows the full enumeration without consulting code. Adding a new key type in the future requires only a new row in `key_types` and a code change, with no schema migration needed.

## rqlite Credentials as Worker Secrets

**Decision:** The rqlite HTTP endpoint URL, Basic Auth username, and Basic Auth password are stored as Cloudflare Worker secrets (`RQLITE_URL`, `RQLITE_USERNAME`, `RQLITE_PASSWORD`). The browser has no knowledge of these values.

**Why:** The browser communicates only with the Worker using Firebase ID tokens. Exposing rqlite credentials to the client would allow any user to query or mutate any row in the database directly, bypassing the Worker's auth enforcement and `user_id` scoping. Keeping credentials in Worker secrets means rqlite is only reachable through the Worker's auth-enforced API.

## Public Keys Stored Unencrypted

**Decision:** `own_public` and `peer_public` entries in `key_store` store raw public key bytes in the `encrypted_data` column without an encryption envelope. The `GET /users/:user_id/public-key` endpoint returns the raw bytes in a `public_key` field, not `encrypted_data`.

**Why:** Public keys are by definition non-secret. Applying an encryption envelope to them would waste space and add complexity without any security benefit, since any party can hold and distribute a public key freely. Using the same `encrypted_data` column for storage simplifies the schema while the route contract and documentation make it explicit that the bytes are unencrypted for these two key types.

## Ascon-Keccak-512 AEAD

**Decision:** All encryption uses leancrypto's Ascon-Keccak-512 AEAD with 512-bit key, IV, and tag.

**Why:** Grover's algorithm halves the effective key length of symmetric ciphers on a quantum computer. 512-bit parameters retain 256-bit post-quantum security margins uniformly across key, IV, and tag. The leancrypto WASM bundle ships with the app, so no additional network dependency is introduced.

## HKDF-SHA3-512 with Per-Blob Fresh Salt

**Decision:** Every encryption derives a unique `(encKey, encIv)` pair from a fresh 64-byte random salt via `HKDF-SHA3-512(ikm=K, salt=randomSalt, length=128)`, where `K` is the appropriate key material for the blob type per the key hierarchy.

**Why:** IV reuse under the same AEAD key is catastrophic — identical `(key, IV)` on two encryptions exposes the XOR of both plaintexts. Per-blob salt derivation makes IV reuse structurally impossible regardless of how many blobs share the same parent key.

## Blob Format with 2-Byte Magic Header

**Decision:** Every encrypted blob is prefixed with a 4-byte header: 2-byte magic (`SB` UTF-8, `0x53 0x42`) and a 2-byte version (`major · minor`). The full header and salt are passed as AEAD additional data so the tag covers the entire blob.

**Why (magic bytes):** Two bytes are sufficient for format identification in hex dumps and for fast-fail rejection of blobs that are not SecBits encrypted objects before any crypto work begins. A shorter magic reduces the fixed overhead of each blob while still making format mismatches immediately visible.

**Why (version field):** The blob format may need to evolve. Without a version field there is no in-band signal to branch on at decode time. Two bytes (major · minor) provide 256 distinct values per component.

**Why (authenticated additional data):** Binding the magic, version, and salt into the AEAD additional data means any modification to any byte in the header causes tag verification to fail, making the full blob tamper-evident.

## Brotli Compression Before Encryption

**Decision:** Entry JSON is Brotli-compressed before AEAD encryption.

**Why:** Encrypted data is statistically indistinguishable from random; a compressor finds no structure in ciphertext. Compressing first takes advantage of the highly repetitive field names in entry JSON and achieves meaningful size reduction. The compressed size is hidden inside the AEAD envelope and unobservable to an attacker.

## Firebase RS256 Token Verification at the Worker

**Decision:** The Worker verifies Firebase ID tokens using Firebase's public JWK endpoint. No external call is made on the authenticated request path after initial key caching.

**Why:** RS256 tokens are self-contained and verifiable by any party with the issuer's public keys. The Worker fetches and caches Firebase's JWK set, then verifies the signature, expiry, and audience locally on every request. This avoids a synchronous call to Firebase on the critical path and does not require a shared secret between the Worker and Firebase.

## In-Memory-Only Session

**Decision:** The root master key, Firebase token, and all decrypted entry data are held only in React component state (JS heap). Nothing is written to `localStorage`, `sessionStorage`, cookies, or IndexedDB.

**Why:** Any persistent browser storage API keeps keying material alive beyond the user's intended session. Holding everything in the JS heap means a hard reload, tab close, or explicit logout clears all secrets immediately and reliably. This also limits the XSS exposure window to the active page lifetime.

## Type and Commit Hash Inside Ciphertext

**Decision:** The entry `type` field and the history commit hash are included only inside the encrypted payload; neither is stored as a plaintext column in rqlite.

**Why:** Storing `type` in plaintext would allow the Worker or anyone with database access to observe the distribution of entry types across users, leaking metadata. Storing the commit hash in plaintext would allow correlation of commit activity without decryption. Keeping both inside the ciphertext means the Worker operates on opaque blobs only and no structural metadata about entries is exposed at the database layer.

## z-base-32 IDs from 256-Bit Random Values

**Decision:** Entry, history, and key IDs are `z-base-32(random 256 bits)`, producing 52-character strings. IDs are generated in the browser with `crypto.getRandomValues` and sent to the Worker.

**Why:** 256-bit random IDs provide negligible collision probability for any realistic vault size. Using the same 256-bit size as SHA3-256 output (used for `user_id`) makes all IDs a uniform 52-character z-base-32 string, simplifying validation. z-base-32 is URL-safe, case-insensitive, and avoids visually ambiguous characters.

## Per-Entry History in rqlite

**Decision:** Each history commit is a row in `entry_history` containing an encrypted full snapshot of the entry at that point in time. The commit hash is embedded inside the encrypted snapshot. History is capped at 20 rows per entry; the oldest row is deleted when the cap is exceeded.

**Why:** Storing history as individual rows lets the Worker retrieve history for a single entry efficiently. Full snapshots per commit are simpler than deltas and eliminate the need to replay a chain to reconstruct a past state. Embedding the commit hash inside the ciphertext means it cannot be tampered with or correlated without the entry key.
