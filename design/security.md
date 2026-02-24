> Part of [Design Docs](../design.md).

# Security Notes

**The master key is everything.** Anyone with your config file can decrypt all your data if they also compromise the Worker or D1 database. Keep the config file off shared machines and out of version control.

**The Worker never sees plaintext.** All encryption and decryption happens in the browser. The Worker and D1 only store ciphertext blobs.

**Per-entry keys.** Each entry is encrypted with its own randomly generated document key. Compromise of one entry's key does not affect others.

**AEAD integrity.** Every encrypted value is authenticated by the Ascon-Keccak-512 AEAD tag. Tampered ciphertext or tag causes decryption to fail before any plaintext is returned.

**No separate MAC step.** Authentication is built into the AEAD cipher; there is no HMAC post-processing step. The tag covers both the ciphertext and the associated key material.

**Email/Password auth.** Credentials are verified by Firebase Authentication, not the Worker. The app signs in via the Firebase REST API, receives an RS256 ID token (1-hour expiry, signed by Google), and forwards it as `Authorization: Bearer <token>` on every Worker request. The Worker verifies the token against Firebase's published public keys and extracts the Firebase UID (`token.sub`) as the canonical user identity. The Worker never handles passwords, stores password hashes, or issues tokens of its own.

**`wrangler.toml` is gitignored.** It contains the D1 `database_id` and worker name. A template (`worker/wrangler.toml.example`) is committed instead. `JWT_SECRET` is stored as a Wrangler secret and never appears in any file.

**Session scope.** The session is held in JS memory only. Nothing is written to `sessionStorage`, `localStorage`, or any other browser store. A hard reload (F5) returns to the config upload screen. The logout button explicitly clears the in-memory key and JWT token. Browser session-restore features may preserve the in-memory state across a browser restart, but this is browser behaviour outside the app's control.

**Content Security Policy.** A CSP meta tag in `index.html` restricts scripts, connections, styles, fonts, and images to known-good origins. `connect-src` allows only `'self'` and `https://*.workers.dev`.
