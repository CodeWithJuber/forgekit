# Security Policy

## Supported Versions

Only the latest release of forgekit receives security updates.

| Version | Supported |
| ------- | --------- |
| latest  | ✅        |
| < latest | ❌       |

## Reporting a Vulnerability

**Do not open a public issue for security vulnerabilities.**

Report privately via GitHub's
[private vulnerability reporting](https://github.com/CodeWithJuber/forgekit/security/advisories/new)
("Report a vulnerability" under the Security tab).

Include: a description and impact, steps to reproduce (a minimal PoC is ideal),
and the forgekit + Node.js versions affected.

## Response

- We aim to acknowledge reports within 72 hours.
- Fixes ship as a patch release; reporters are credited in the changelog unless
  they prefer to remain anonymous.

## Note on the security you get from forgekit

forgekit's own `skill-gate` (`forge scan`) vets third-party skills/MCP servers for
prompt-injection / RCE / exfil before install, and its guards block secret-file
writes and redact secrets from tool output. These reduce, but do not eliminate,
supply-chain risk — always review a third-party skill/plugin before installing it.
