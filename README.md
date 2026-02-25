# SecBits

Offline-first CLI password manager in Rust. Pass-style path UX, AES-equivalent post-quantum encryption, SQLite local storage, S3-compatible encrypted backups.

## Setup

**1. Generate a root master key:**

```bash
openssl rand -base64 344 | tr -d '\n'
```

**2. Create config** (`~/.config/secbits/config.toml`):

```toml
root_master_key_b64 = "<base64 key from above>"
db_path             = "~/.local/share/secbits/secbits.db"
username            = "alice"
backup_on_save      = false   # optional; auto-push after insert/edit/restore
log_level           = "info"  # optional: trace | debug | info | warn | error

[targets.r2]            # optional; one or more S3-compatible backup targets
provider          = "r2"
endpoint          = "https://<account>.r2.cloudflarestorage.com"
region            = "auto"
bucket            = "secbits-backups"
prefix            = "prod/"
access_key_id     = "..."
secret_access_key = "..."
```

Providers: `r2`, `aws`, `gcs`. Config path override: `--config <path>` or `$SECBITS_CONFIG`.

**3. Initialize:**

```bash
secbits init --username alice
```

## Commands

```
secbits init --username <name>             Create user and store wrapped master key
secbits ls [prefix]                        List entry paths, optionally filtered
secbits show <path>                        Decrypt and print latest snapshot
secbits insert <path>                      Add new entry (interactive or piped JSON)
secbits edit <path>                        Edit existing entry
secbits rm <path>                          Delete entry (requires confirmation)
secbits history <path>                     Print commit history
secbits restore <path> --commit <hash>     Restore entry to a prior commit
secbits totp <path>                        Compute current TOTP code(s)
secbits export --output <file>             Plaintext JSON export of all entries

secbits backup push --target <name>|--all  Encrypt and upload local DB to S3
secbits backup pull --target <name>        Download and restore DB from S3

secbits share-init                         Generate ML-KEM-1024+X448 keypair
secbits share-pubkey [--output <file>]     Export own hybrid public key
secbits share <path> --recipient-key <f>   Encrypt entry snapshot for recipient
secbits share-receive [--input <f>]        Decrypt and import a shared entry
```

Path arguments support fuzzy regex matching. Case-smart: uppercase in query → case-sensitive.

## Non-interactive Insert

```bash
echo '{"title":"Gmail","username":"alice@gmail.com","password":"s3cr3t","notes":"",
  "urls":["https://mail.google.com"],"totpSecrets":[],"customFields":[],"tags":[],"timestamp":""}' \
  | secbits insert mail/google/main
```

## Building

```bash
cargo build --release
```

Requires system libraries: `libleancrypto`, `libbrotlienc`, `libbrotlidec`, `libsqlite3`.

## Crypto

- Key wrap: HKDF-SHA3-512 + Ascon-Keccak-512 AEAD (512-bit key/IV/tag)
- Blob format: `salt(64B) || ciphertext || tag(64B)`
- Entry storage: `entry_key = wrap(user_master_key, doc_key)`, `value = encrypt(doc_key, brotli(JSON(history)))`
- Sharing: ML-KEM-1024 + X448 hybrid KEM via leancrypto `lcr_kyber_x448`
- Commit hash: SHA-256 first 12 hex chars (identity only, not security-critical)

See `agent_docs/` for detailed design: `crypto.md`, `model.md`, `backup.md`, `sharing.md`, `testing.md`.
