# Testing

## Focus Areas

1. Firebase auth integration at client and Worker boundary.
2. Worker token verification and unauthorized access rejection.
3. R2 write path (`PUT /vault`) with config-driven key resolution.
4. R2 read path (`GET /vault`) including first-login empty state.
5. Crypto pipeline round-trip:
   - export JSON
   - compress
   - encrypt
   - decrypt
   - decompress
   - parse JSON
6. Tamper detection for encrypted blobs.
7. Config validation for `bucket_name`, `prefix`, and `file_name`.

## Suggested Commands

```bash
npx vitest run
npx vitest
```

## Regression Priorities

- Login must read vault from R2 (not any database).
- Save must overwrite/update encrypted vault object in R2.
- Backup-related UI/API paths must not exist.
- No migration flow should be required or invoked.
