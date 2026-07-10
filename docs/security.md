# Security

Threat model and guarantees for the current design. See docs/architecture.md, docs/crypto.md, and docs/data_model.md for the mechanisms referenced here.

## What this protects against

- **Network attacker**: TLS to Firebase and InstantDB, plus end to end encryption underneath, so even a full TLS compromise only exposes ciphertext and the metadata InstantDB already sees.
- **InstantDB compromise or breach**: InstantDB stores only opaque encrypted blobs plus row ids and owner/entry links (see docs/data_model.md, Entities and Links). A full database dump exposes ciphertext and who owns which rows, never plaintext.
- **Malicious or careless InstantDB staff**: same guarantee as above; InstantDB itself never holds a decryption key.
- **Cross user access**: permission rules scope every row to `auth.id` (see docs/data_model.md, Permission rules); one authenticated user cannot read another user's `entries`, `entryHistory`, or `keyStore` rows.
- **Ownership hijack via update**: `newData.owner == data.owner` on the `entries` and `keyStore` update rules stops a user reassigning their own row onto another user's account after creation.
- **History tampering**: `entryHistory.update` is `false`; history snapshots can only be created or deleted, never rewritten in place.
- **Wrong key or tampered blob**: AEAD authentication covers the full blob, magic, version, salt, and ciphertext, as additional data. A single bit change anywhere, or a decrypt attempt with the wrong key, fails closed before any plaintext is returned (see docs/crypto.md, AEAD Additional Data and Security Properties).

## What this does not protect against

- **Local device compromise**: `root_master_key`, `email`, `password`, and the R2/S3 backup access keys all live in a local config file in the clear. Anyone with read access to that file, or to process memory while the app is running with the vault decrypted, has full access. This design assumes a trusted local machine; it does not defend against malware, a compromised OS account, or physical access to an unlocked device.
- **Local unencrypted backup**: the on demand local backup is the full vault, decrypted, written to disk as plain JSON. This is a bigger exposure than the config file: reading it requires no secret at all, not even `root_master_key`. It exists deliberately as an unprotected escape hatch (see docs/features.md, Backup); anywhere that file is copied to, synced, or backed up by something else becomes a full plaintext copy of the vault.
- **Compromised Firebase credentials**: an attacker who obtains the Firebase email and password can authenticate as the user and reach their InstantDB rows, but still cannot decrypt them without `root_master_key`. This is an availability and integrity risk, they can delete or overwrite rows, including planting a duplicate `keyStore` row (see docs/data_model.md, Uniqueness), not a confidentiality one.
- **Compromised build or hosting**: Cloudflare Pages, its CDN, and the repository serving the frontend JS are trusted. A compromised build could ship code that exfiltrates `root_master_key` or plaintext directly; nothing in the crypto design defends against a malicious client.
- **Coarse size metadata**: ciphertext length reveals an approximate plaintext size even though content stays hidden (see docs/crypto.md, Security Properties).
- **Weak or unseeded RNG**: every guarantee here assumes the WASM RNG is properly seeded before generating salts or keys (see docs/crypto.md, Entropy Precondition). An unseeded or predictable RNG breaks confidentiality regardless of the algorithms used.
- **Duplicate `keyStore` rows**: one row per user is an assumption, not an enforced invariant (see docs/data_model.md, Uniqueness). A duplicate row is currently a fatal error condition the app must detect, not a boundary actively defended by the schema.
- **Cloud backups sit on infrastructure this project does not control**: R2 and any configured S3 compatible endpoint are third parties, holding ciphertext for potentially longer retention than anything in InstantDB. Confidentiality still holds as long as `backupKey` is never exposed, but that ciphertext is now also subject to that provider's own retention, access controls, and breach history, none of which this design can influence.

## Deliberately out of scope for now

- Sharing entries between users: would need a public/private keypair per user; not implemented.
- One time share links: would need a new, unauthenticated read path and, for a real single view guarantee, a privileged component this design otherwise avoids. Deferred.
- Rate limiting or brute force protection on the Firebase login itself: relies on whatever Firebase Authentication provides by default.

## Recovery

- **Suspected `root_master_key` compromise**: rotate it (see docs/crypto.md, Key Rotation). Only `keyStore.umkBlob` needs re encrypting.
- **Suspected UMK compromise**, or after revoking a device that cached it: rotate the UMK (see docs/crypto.md, Key Rotation). Every `entryKey` is re wrapped, atomically, in one transaction.
- **Suspected `backupKey` compromise**, or a suspected leak at the R2/S3 provider: rotate the backup key (see docs/crypto.md, Key Rotation). This only protects future backups; past backup objects remain under the old key unless separately re encrypted and re uploaded.
- Neither rotation helps against an attacker who already exfiltrated `root_master_key` along with a copy of the ciphertext from before rotation; rotation protects future compromise of stored ciphertext, not past exposure of already decrypted plaintext.
