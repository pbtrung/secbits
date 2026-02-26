# Design

Architecture decisions and their rationale.

---

## Firebase Auth → Worker → R2

**Decision:** Firebase Authentication issues the identity token; a Cloudflare Worker enforces auth and mediates R2 access; Cloudflare R2 stores the encrypted vault object.

**Why:** Each layer has a single, bounded responsibility. Firebase handles credential management and token issuance without the Worker needing to store passwords or issue its own tokens. The Worker is a thin auth-enforcement and storage gateway — it never touches plaintext. R2 holds one opaque binary object per user vault. There is no SQL schema, no relational model, and no secondary storage layer.

---

## Single Encrypted Vault Object

**Decision:** The entire vault is one encrypted binary object stored at a config-driven R2 path. Every save overwrites the object; every login reads it.

**Why:** Password vault data does not benefit from relational queries against ciphertext. A single object eliminates schema management, row-level key bookkeeping, and partial-write consistency problems. The read and write paths are symmetric and simple. Recovery requires only the config file and the R2 object.

---

## Export JSON as the Canonical Storage Format

**Decision:** The persisted payload is the export JSON serialized, Brotli-compressed, and AEAD-encrypted. The in-memory format and the stored format are the same structure.

**Why:** A single format eliminates translation between internal representation and a separate storage schema. The export file a user downloads is byte-for-byte the same payload structure stored in R2, making manual recovery straightforward without special tooling.

Export JSON shape:

```json
{
  "version": 1,
  "username": "<display name>",
  "data": [ /* live entries */ ],
  "trash": [ /* deleted entries, each with deletedAt */ ]
}
```

`version` is a schema version integer. It exists so future format changes can be handled by branching on the version at parse time. Currently always `1`.

`data` contains live entries. `trash` contains entries moved there by a soft delete; each carries all original fields, the full `_commits` history, and an added `deletedAt` ISO 8601 timestamp. Entries absent from both arrays are permanently gone.

---

## Single Root Master Key

**Decision:** One root master key (RMK), supplied from the config JSON, directly derives the AEAD encryption key for the entire vault blob.

**Why:** The RMK is the trust anchor for the vault. Given that the config file is the user's primary secret and each user has an independent vault, additional indirection layers (UMK, per-entry doc keys) add complexity without providing meaningful security benefit under this threat model. A leaked RMK already implies a fully compromised vault regardless of how many wrapping layers exist; protecting the config file is the correct defense. The single-key model keeps the code path auditable and eliminates classes of bugs around key generation, wrapping, and zeroing across multiple layers.

---

## Ascon-Keccak-512 AEAD

**Decision:** All encryption uses leancrypto's Ascon-Keccak-512 AEAD with 512-bit key, IV, and tag.

**Why:** Grover's algorithm halves the effective key length of symmetric ciphers on a quantum computer. 512-bit parameters retain 256-bit post-quantum security margins uniformly across key, IV, and tag. The leancrypto WASM bundle ships with the app, so no additional dependency is introduced.

---

## HKDF-SHA3-512 with Per-Blob Fresh Salt

**Decision:** Every encryption derives a unique `(encKey, encIv)` pair from a fresh 64-byte random salt via HKDF-SHA3-512.

**Why:** IV reuse under the same AEAD key is catastrophic — identical `(key, IV)` on two encryptions exposes the XOR of both plaintexts. Per-blob salt derivation makes IV reuse structurally impossible: the caller stores only the static RMK; all per-blob key material is ephemeral and never stored.

---

## Brotli Compression Before Encryption

**Decision:** Export JSON is Brotli-compressed before AEAD encryption.

**Why:** Encrypted data is statistically indistinguishable from random; a compressor finds no structure in ciphertext. Compressing before encryption takes advantage of the highly repetitive field names in entry JSON (`title`, `username`, `password`, `urls`, etc.) and achieves 50–70% size reduction. The compressed size is hidden inside the AEAD envelope and unobservable to an attacker.

---

## Firebase RS256 Token Verification at the Worker

**Decision:** The Worker verifies Firebase ID tokens using Firebase's public JWK endpoint. No external call is made on the authenticated request path after initial key caching.

**Why:** RS256 tokens are self-contained and verifiable by any party with the issuer's public keys. The Worker fetches and caches Firebase's JWK set, then verifies the signature, expiry, and audience locally on every request. This avoids a synchronous call to Firebase on the critical path and does not require a shared secret between the Worker and Firebase.

---

## In-Memory-Only Session

**Decision:** The root master key, Firebase token, and all decrypted vault data are held only in React component state (JS heap). Nothing is written to `localStorage`, `sessionStorage`, cookies, or IndexedDB.

**Why:** Any persistent browser storage API keeps keying material alive beyond the user's intended session. Holding everything in the JS heap means a hard reload, tab close, or explicit logout clears all secrets immediately and reliably. This also limits the XSS exposure window to the active page lifetime.

---

## UUID Entry IDs

**Decision:** New persisted entries are assigned IDs with `crypto.randomUUID()`.

**Why:** Native UUID generation is collision-resistant for this use case, avoids custom ID schemes, and keeps ID generation logic simple and auditable.

---

## R2 Path Derived from vault_id

**Decision:** The R2 object key is `{vault_id}/{file_name}`, where `vault_id` is a stable random string from the client config, sent in the request body and validated server-side. The bearer token is still verified on every request; `vault_id` determines the storage path independently of the auth provider.

**Why:** Tying the path namespace to an auth-provider identity (e.g. Firebase UID) would couple storage layout to the auth layer — switching auth backends would relocate the vault and require data migration. Using a config-supplied `vault_id` keeps the path stable across auth changes. Path isolation relies on the secrecy of `vault_id`, which lives in the config alongside the root master key — consistent with the overall trust model where the config file is the trust anchor.
