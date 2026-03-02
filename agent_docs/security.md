# Security

## Threat Model

**Trust anchor: the config file.** The config JSON holds the root master key, Firebase credentials, and vault_id. Protecting the config file is the primary security obligation. An attacker who obtains the config file and can query rqlite (via the Worker) can decrypt all vault entries offline.

**The Worker and rqlite are untrusted.** They store and relay ciphertext only. A fully compromised Worker or rqlite instance reveals no plaintext without the root master key.

**rqlite is not directly accessible from the browser.** The Worker holds rqlite credentials as secrets. All database access is mediated by the Worker's auth-enforcement layer.

## Guarantees

**End-to-end encryption.** All encryption and decryption runs in the browser. The Worker and rqlite never handle plaintext. Both live entries and trashed entries are stored as independent encrypted blobs.

**Authenticated encryption.** Every blob carries a 64-byte Ascon-Keccak-512 AEAD tag. The tag covers the full blob — magic bytes, version, salt, and ciphertext — via AEAD additional data. Any modification to any byte in the blob causes decryption to throw before returning any plaintext.

**No IV reuse.** Each encryption derives a unique `(encKey, encIv)` from a fresh 64-byte random salt via HKDF-SHA3-512. IV reuse is structurally impossible.

**Post-quantum margins.** 512-bit key, IV, and tag provide 256-bit post-quantum security against Grover's algorithm.

**In-memory session.** Root master key, Firebase token, and decrypted entry data live only in the JS heap. Nothing is written to `localStorage`, `sessionStorage`, cookies, or IndexedDB. A hard reload or logout clears all keying material immediately.

**Firebase token enforcement.** The Worker verifies the RS256 signature, expiry, and audience of every Firebase ID token on every request. Expired or forged tokens are rejected before any rqlite operation.

**vault_id scoping.** All rqlite queries are scoped to the `vault_id` from the client config. A client without the config cannot determine which rows belong to a given vault. The Worker verifies the Firebase token before using the client-supplied `vault_id` as a query filter. `vault_id` is sanitized to reject `..` and `\`.

**rqlite credential isolation.** The rqlite URL and Basic Auth credentials are stored exclusively as Worker secrets. They are never sent to the browser or included in any API response. Only the Worker can communicate with rqlite.

**Parameterized SQL.** All rqlite queries use parameterized statements. No string interpolation is used to construct SQL, eliminating SQL injection.

## XSS Exposure Window

Decrypted entry data lives in the JS heap for the duration of the session. A successful XSS attack during an active session can read all decrypted entries and the root master key. Mitigation: short session lifetime, logout when idle, a strict Content Security Policy restricting script sources.

## Config File Guidance

- Keep `secbits-config.json` off shared machines and out of version control.
- The `root_master_key` field must be at least 256 bytes when base64-decoded. Use the Security settings page to generate a cryptographically random key.
- After rotating the root master key, update the config file immediately. The old key stops working as soon as all entry blobs are re-encrypted and written to rqlite.
- The `vault_id` field must be a cryptographically random string of at least 16 bytes. Treat it with the same sensitivity as the root master key.

## Root Master Key Rotation

Rotation re-encrypts every entry blob and every history commit blob with a new key and fresh salts. If the browser is closed or the tab is killed mid-rotation, some blobs may be encrypted with the old key and some with the new key. The rotation operation should be retried until all blobs are re-encrypted. The old key remains valid for any blobs that have not yet been re-encrypted.
