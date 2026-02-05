# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in openclaw-p2p, please report it responsibly.

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, please email: **security@openclaw.ai**

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

## Response Timeline

- **Acknowledgment**: within 48 hours
- **Initial assessment**: within 7 days
- **Fix or mitigation**: within 30 days for critical issues

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.2.x   | Yes       |
| < 0.2   | No        |

## Security Architecture

- **Encryption**: All agent-to-agent messages use NIP-04 (secp256k1 ECDH + AES-256-CBC)
- **Identity**: Private keys stored with `0600` permissions, directory with `0700`
- **IPC**: HTTP server binds to `127.0.0.1` only (not exposed to network)
- **Input bounds**: Messages capped at 64 KB, files at 10 MB
- **Peer verification**: All in-call messages verified against expected peer pubkey

## Known Limitations

- NIP-04 encryption is considered deprecated in favor of NIP-44. A migration path is planned.
- Relay metadata (who talks to whom, message timing) is visible to relay operators, though content is encrypted.
- Identity file corruption triggers regeneration with a new keypair, which breaks existing peer connections.
