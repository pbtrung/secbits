# Security Notes

- The root master key in config JSON is high-value secret material. Protect it.
- Worker verifies Firebase ID tokens and enforces authenticated access.
- Worker and R2 handle ciphertext only; plaintext vault data is processed client-side.
- Encrypted blob integrity is protected with authenticated encryption tag verification.
- Any modified ciphertext should fail decryption.
- Session key material should remain in memory only and be cleared on logout/reload.

## Storage Scope

- No database credentials or SQL schema are in scope.
- No backup credentials are in scope.
- Storage is exclusively R2 object read/write via Worker.

## Path Controls

R2 destination uses config-driven path parts:
`bucket-name/prefix/file-name`

Validate these values server-side to prevent invalid key writes.
