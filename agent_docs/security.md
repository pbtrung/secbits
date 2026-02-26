# Security

## Threat Model

**Trust anchor: the config file.** The config JSON holds the root master key, Firebase credentials, and R2 path. Protecting the config file is the primary security obligation. An attacker who obtains the config file and the R2 object can decrypt the vault offline.

**The Worker and R2 are untrusted.** They store and relay ciphertext only. A fully compromised Worker or R2 account reveals nothing about vault content without the root master key.

## Guarantees

**End-to-end encryption.** All encryption and decryption runs in the browser. The Worker and R2 never handle plaintext.

**Authenticated encryption.** Every vault blob carries a 64-byte Ascon-Keccak-512 AEAD tag. Any modification to ciphertext or tag causes decryption to throw before returning any plaintext.

**No IV reuse.** Each encryption derives a unique `(encKey, encIv)` from a fresh 64-byte random salt via HKDF-SHA3-512. IV reuse is structurally impossible.

**Post-quantum margins.** 512-bit key, IV, and tag provide 256-bit post-quantum security against Grover's algorithm.

**In-memory session.** Root master key, Firebase token, and decrypted vault data live only in the JS heap. Nothing is written to `localStorage`, `sessionStorage`, cookies, or IndexedDB. A hard reload or logout clears all keying material immediately.

**Firebase token enforcement.** The Worker verifies the RS256 signature, expiry, and audience of every Firebase ID token. Expired or forged tokens are rejected before any R2 operation.

**Path isolation via vault_id.** The R2 object key is `{vault_id}/{file_name}`. `vault_id` is a secret random string from the config (alongside the root master key); a client without the config cannot determine the storage path. `bucket_name` is validated against the Worker's `R2_BUCKET_NAME` secret; `vault_id` and `file_name` are sanitized to reject `..` and `\`. The bearer token is still verified on every request.

## XSS Exposure Window

The decrypted vault lives in the JS heap for the duration of the session. A successful XSS attack during an active session can read all decrypted entries. Mitigation: short session timeout, logout when idle, Content Security Policy restricting script sources.

## Config File Guidance

- Keep `secbits-config.json` off shared machines and out of version control.
- The `root_master_key` field must be at least 256 bytes when base64-decoded. Use the Security settings page to generate a cryptographically random key.
- After rotating the root master key, update the config file immediately. The old key stops working as soon as the new encrypted vault is written to R2.

## Root Master Key Rotation

Rotation re-encrypts the entire vault blob with a new key and fresh salt. The operation is atomic from the R2 perspective — the old object is overwritten only after the new ciphertext is ready. If the browser is closed or the tab is killed mid-rotation before the write completes, the old key remains valid.
