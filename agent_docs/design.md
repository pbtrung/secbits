# Design — SecBits

Architecture decisions and their rationale.

---

## Client-Side Cryptography

**Decision:** All encryption and decryption runs in the browser. The Cloudflare Worker and D1 store only ciphertext blobs.

**Why:** The Worker is a CRUD API exposed to the internet. A compromised Worker, a D1 data breach, or a Cloudflare insider threat reveals nothing about entry content when the server never handles plaintext. This reduces the trust requirement for the entire backend to zero — the Worker can be treated as an untrusted pipe.

Contrast with server-side crypto: the server becomes a target. Compromise of the server key compromises every user's data simultaneously.

---

## Ascon-Keccak-512 AEAD

**Decision:** Use leancrypto's Ascon-Keccak-512 AEAD with 512-bit key, IV, and tag.

**Why:** Grover's algorithm halves the effective key length of symmetric ciphers on a quantum computer. A 512-bit key retains 256-bit post-quantum security. Using 512-bit parameters across key, IV, and tag provides a uniform post-quantum margin. The leancrypto WASM bundle is already shipped in the app — no additional dependency.

Contrast with AES-256-GCM via WebCrypto: only classical security, 96-bit IV (IV reuse risk at scale), 128-bit tag (64-bit PQ authentication security).

---

## HKDF-SHA3-512 with Per-Blob Fresh Salt

**Decision:** Every encryption derives a unique `(encKey, encIv)` pair from a fresh 64-byte random salt via HKDF-SHA3-512.

**Why:** IV reuse under the same AEAD key is catastrophic — identical `(key, IV)` on two messages can expose the plaintext XOR of both. By deriving a distinct key+IV from a new random salt on every call, IV reuse is structurally impossible regardless of how many times the same master key is reused. The caller stores only the master key; all per-blob key material is ephemeral.

---

## Three-Level Key Hierarchy

**Decision:** Root Master Key (RMK) → User Master Key (UMK) → per-entry Doc Keys.

**Why:**

- **Root key rotation** rewraps only the 192-byte UMK blob in D1. Entry data is untouched regardless of how many entries exist. With direct RMK-to-entry encryption, rotation would require downloading, decrypting, re-encrypting, and re-uploading every entry.
- **Key isolation**: compromise of a single doc key affects only that entry; all others remain protected.
- **Trust layers**: the RMK never touches the server; UMK and doc keys reach the server only as opaque ciphertext blobs.

---

## Per-Entry Document Keys

**Decision:** Each entry is encrypted with its own randomly generated 64-byte document key. The doc key is AEAD-encrypted with the UMK and stored alongside the entry (`entry_key` column).

**Why:** Mirrors envelope encryption (AWS KMS pattern). The master key wraps data keys rather than encrypting data directly. This gives per-entry revocability and bounds the blast radius of any key compromise to a single entry.

---

## Brotli Compression Before Encryption

**Decision:** History JSON is Brotli-compressed before AEAD encryption.

**Why:**
1. Encrypted data is statistically indistinguishable from random bytes; a compressor finds no structure in it. Compressing after encryption is a no-op.
2. History JSON has repetitive field names (`title`, `username`, `password`, etc.) across many commits; Brotli achieves 50–70% reduction.
3. No timing oracle: the compressed size is hidden inside the AEAD envelope and never observable by an attacker.

---

## Compact History: Head Snapshot + Deltas

**Decision:** Each entry stores the full current snapshot at `head_snapshot`, delta-compressed metadata for older commits, capped at 20 commits.

**Why:** The most common operation (`show`, `totp`, edit) reads the current state. Storing it directly at `head_snapshot` makes that O(1) — no delta traversal. Older commits store only field-level `set`/`unset` deltas relative to the next-newer commit, keeping the history object small. The 20-commit cap bounds storage growth unconditionally.

Contrast with full-snapshot-per-commit: unbounded storage growth, no size benefit. Contrast with delta-only (no head snapshot): O(N) traversal on every read of current state.

---

## Firebase Authentication

**Decision:** Email/password auth via Firebase Authentication; the app exchanges credentials for an RS256 JWT and forwards it as `Authorization: Bearer` on every Worker request.

**Why:** Firebase manages password hashing, account storage, token issuance, and key rotation. RS256 tokens are verifiable by any party holding the Firebase public keys, so the Worker authenticates requests without contacting Firebase at request time (after an initial JWK fetch + cache). This avoids a synchronous external call on the critical path.

---

## Cloudflare Workers + D1

**Decision:** Stateless edge Workers handle the API; D1 (serverless SQLite) stores user and entry rows.

**Why:** No server provisioning or maintenance. D1 is SQLite — the schema is already written for a relational model. Workers have sub-millisecond cold starts globally. Cost is zero at personal-use scale. The data model (users + entries, no complex joins) is a comfortable fit for a managed edge SQL service.

Contrast with a traditional VPS: ongoing maintenance, patching, uptime. Contrast with Firebase Firestore: NoSQL document model maps awkwardly to structured entry rows.

---

## In-Memory-Only Session

**Decision:** The root master key, decrypted UMK, and Firebase token are held only in React component state (JS heap). Nothing is written to `localStorage`, `sessionStorage`, cookies, or IndexedDB.

**Why:** Any browser storage API that survives a page reload keeps the master key alive beyond the user's intent to log out. Holding everything in the JS heap means a hard reload (F5), tab close, or explicit logout reliably clears all keying material. This also limits the XSS exposure window to the current page lifetime — an attacker who injects a script can only steal the key while the tab is open.

---

## S3-Compatible Backup Without a Cloud SDK

**Decision:** Cloud backup uses a minimal SigV4 (HMAC-SHA256) implementation that covers Cloudflare R2, AWS S3, and GCS — no provider SDK.

**Why:**
- Cloud provider SDKs add hundreds of kilobytes to the bundle and may not work correctly in a browser context.
- The S3 PUT/GET object API surface is the same across all three providers; one code path serves all targets.
- SigV4 needs only HMAC-SHA256, available via WebCrypto, keeping the implementation free of extra dependencies.
