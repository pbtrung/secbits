# Backup Status

Backup feature has been removed in this design.

## What changed

- Previous explicit backup/restore subsystem is deleted.
- R2 is now the primary storage, not a backup target.
- Vault persistence is done directly through Worker `GET /vault` and `PUT /vault`.

## Current persistence model

Every save writes the full encrypted export object to R2.
Every login reads the same encrypted object from R2.

Pipeline:
`export JSON -> compress -> encrypt -> R2`

There is no separate "backup now" or "auto-backup" function.
