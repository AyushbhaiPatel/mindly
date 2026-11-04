# Security policy

## Reporting a vulnerability

Please do not open a public issue for security problems. Use GitHub's
[private vulnerability reporting](../../security/advisories/new) for this repository.

Include affected version, reproduction steps and impact. We aim to acknowledge reports within
three working days and to ship a fix or mitigation for confirmed high-severity issues within 30
days.

## Scope

In scope: the CLI, daemon, dashboard, MCP server, adapters and storage. Particularly interesting:
memory-based prompt injection that bypasses the trust labels, command execution from repository
content, daemon authentication bypass, secrets persisted despite redaction, and path traversal.

See [docs/security.md](docs/security.md) for the threat model.
