# Features

| Feature | Description |
|---|---|
| End-to-end encryption | Ascon-Keccak-512 AEAD; the server stores only ciphertext |
| Per-entry document keys | Each entry uses its own randomly generated key |
| Version history | Git-like commit chain per entry: content-addressed commits, changed-field annotations, modal diff viewer, one-click restore |
| TOTP generation | Live 6-digit codes with countdown timer |
| Password generator | Configurable charset, length 8 to 128, entropy display |
| Custom fields | Arbitrary key/value pairs per entry |
| Tags | Organize entries with comma-separated tags; sidebar filter with counts |
| Full-text search | Searches title, username, and URLs in real time |
| Backup | Encrypted cloud backup to R2, S3, or GCS; manual trigger or auto-backup after every save |
| Restore | Recover all entries from a cloud backup, a local `.bak` file, or a plain JSON export |
| Export | Download all entries as a decrypted JSON file for local backup or migration |
| Root master key rotation | Re-encrypts only the user master key blob; entry data is untouched |
| Responsive layout | Three-column resizable desktop view; stacked mobile navigation |
| Session persistence | Session held in memory only; nothing written to any browser store. Cleared on logout or hard reload |
| Clipboard auto-clear | Clipboard is overwritten 30 seconds after any copy |
| Notes auto-hide | Revealed notes are hidden after 15 seconds or on window blur |
