# Security Notes

**The master key is everything.** Anyone with your config file can decrypt all your data if they also access the InstantDB store. Keep the config file off shared machines and out of version control.

**InstantDB never sees plaintext.** All encryption and decryption happens in the browser. InstantDB stores only ciphertext blobs. Permission rules prevent other users from reading your ciphertext, but the ciphertext itself is worthless without the Root Master Key from the config file.

**Per-entry keys.** Each entry is encrypted with its own randomly generated document key. Compromise of one entry's key does not affect others.

**AEAD integrity.** Every encrypted value is authenticated by the Ascon-Keccak-512 AEAD tag. Tampered ciphertext or tag causes decryption to fail before any plaintext is returned.

**No separate MAC step.** Authentication is built into the AEAD cipher; there is no HMAC post-processing step. The tag covers both the ciphertext and the associated key material.

**Email/Password auth.** Authentication is fully delegated to Firebase. The app exchanges credentials for an RS256 ID token, then calls `db.auth.signInWithIdToken()`. InstantDB verifies the token against Firebase's public JWKs; no password or hash is ever sent to InstantDB. See `agent_docs/backend.md` for the full auth flow and `agent_docs/design.md` for why Firebase was chosen.

**Session scope.** The session is held in JS memory only. Nothing is written to `sessionStorage`, `localStorage`, or any other browser store. A hard reload (F5) returns to the config upload screen. The logout button explicitly clears the in-memory key and Firebase token.

**Content Security Policy.** A CSP meta tag in `index.html` restricts scripts, connections, styles, fonts, and images to known-good origins. `connect-src` allows only `'self'`, `https://*.instantdb.com`, and `wss://*.instantdb.com`.

**Root master key rotation.** Rotating the root master key re-encrypts only the 192-byte user master key blob in InstantDB. Entry keys and values are unaffected. The old key immediately stops working once the new blob is written. If the new key is not saved before confirming, data cannot be recovered.
