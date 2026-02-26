# Features

| Feature | Description |
|---|---|
| End-to-end encryption | Vault data is encrypted client-side before Worker/R2 storage |
| Firebase login | Email/password auth with Firebase ID token |
| Worker-mediated storage | Worker verifies token and mediates R2 reads/writes |
| R2 canonical vault object | Single encrypted vault object persisted in R2 |
| Export-format persistence | Stored payload is export JSON -> compressed -> encrypted |
| Config-driven R2 path | Uses `bucket-name/prefix/file-name` values from config JSON |
| Login-time load | App reads encrypted vault object from R2 on login |
| No backup subsystem | Backup-specific flows and UI are removed |
| No migration requirement | New independent design starts from scratch |
