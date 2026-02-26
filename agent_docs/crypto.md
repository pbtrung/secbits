# Cryptographic Design

## Core Pipeline

Vault persistence format:
1. Build export JSON object.
2. Serialize to UTF-8 JSON bytes.
3. Compress bytes.
4. Encrypt compressed bytes.
5. Store encrypted blob in R2.

Load path is the reverse:
1. Read encrypted blob from R2.
2. Decrypt blob.
3. Decompress bytes.
4. Parse JSON.

## Key Model

- Root master key is supplied from config JSON.
- Key material remains client-side for encryption/decryption.
- Worker and R2 only handle ciphertext.

## Blob Format

Encrypted blob format remains:
`salt || ciphertext || tag`

Where:
- `salt` is random per encryption operation.
- `ciphertext` is encrypted compressed export bytes.
- `tag` authenticates integrity.

## Security Properties

- Any ciphertext tamper should fail authenticated decryption.
- Wrong root master key should fail decryption.
- Fresh salt prevents deterministic output reuse for identical plaintext.

## Scope Changes

- No database row-level encryption model is required.
- No backup-specific encryption format is needed.
- Export format is the canonical storage format.
