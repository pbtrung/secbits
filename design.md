# SecBits — Design Docs

Architecture, cryptography, security, and testing reference for the SecBits password manager. For installation, configuration, and usage see the [README](README.md).

## Contents

| Document | Description |
|---|---|
| [Features](design/features.md) | Full feature list with descriptions |
| [Cryptographic Design](design/crypto.md) | Key hierarchy, algorithms, blob format, master key flow, entry encryption, commit chain, and compact storage format |
| [Security Notes](design/security.md) | Threat model, key management, session scope, and CSP policy |
| [Tech Stack and Project Structure](design/tech-stack.md) | Library choices and annotated source tree |
| [Testing](design/testing.md) | Why each test area matters, how each test suite works, and the performance load script |
| [D1 + Workers Backend](design/d1.md) | Cloudflare D1 + Workers backend architecture: schema, API design, auth, and client-side API |
