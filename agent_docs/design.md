# Design Decisions

## Firebase Auth -> Worker -> R2

Decision: use Firebase Authentication for identity, Worker for API enforcement, and R2 for encrypted object storage.

Why:
- Minimal backend surface.
- No SQL schema management.
- Strong separation: auth, compute, storage.

## No Database

Decision: remove Turso/libSQL/D1 entirely.

Why:
- This design stores one encrypted vault object per user path.
- Relational querying is not required for ciphertext object persistence.
- Operational complexity is lower.

## Export Format As Primary Storage

Decision: canonical persisted payload is export JSON after compression and encryption.

Why:
- Single format for write and read.
- Eliminates translation between internal/backup formats.
- Keeps recovery path simple and deterministic.

## Config-Driven R2 Path

Decision: path parts are supplied by JSON config.

Required path contract:
`bucket-name/prefix/file-name`

Why:
- Deployments can customize storage layout without code changes.
- Same client can target different buckets/prefixes.

## Backup Removal

Decision: remove backup feature as a separate subsystem.

Why:
- R2 write is the primary persistence action.
- Avoid duplicate pathways and UI complexity.
- Matches scratch redesign requirement.

## Start From Scratch

Decision: no migration support.

Why:
- This is an independent architecture.
- Previous data model compatibility is explicitly out of scope.
