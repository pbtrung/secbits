> Part of [Design Docs](../design.md).

# Security Notes

**The master key is everything.** Anyone with your config file and access to your Firestore database can decrypt all your data. Keep the config file off shared machines and out of version control.

**Firebase never sees plaintext.** All encryption and decryption happens in the browser. Firestore only stores ciphertext blobs.

**Per-entry keys.** Each entry is encrypted with its own randomly generated document key. Compromise of one entry's key does not affect others.

**AEAD integrity.** Every encrypted value is authenticated by the Ascon-Keccak-512 AEAD tag. Tampered ciphertext or tag causes decryption to fail before any plaintext is returned.

**No separate MAC step.** Authentication is built into the AEAD cipher; there is no HMAC post-processing step. The tag covers both the ciphertext and the associated key material.

**Email/Password auth.** Firebase Email/Password Authentication is used to satisfy Firestore security rules. Only the pre-created account can sign in.

**Session scope.** The session is held in JS memory only. Nothing is written to `sessionStorage`, `localStorage`, or any other browser store. A hard reload (F5) returns to the config upload screen. The logout button explicitly clears the in-memory key. Browser session-restore features may preserve the in-memory state across a browser restart, but this is browser behaviour outside the app's control.

**Content Security Policy.** A CSP meta tag in `index.html` restricts scripts, connections, styles, fonts, and images to known-good origins.
