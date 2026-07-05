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

## Threat model (what's in and out of scope)

**In scope:** the forgekit CLI and its emitters/guards; the `skill-gate` scanner; secret
handling in guards; the install channels; the supply chain of our own dev dependencies.

**Out of scope:** vulnerabilities in the third-party tools Forge configures (Claude Code,
Cursor, Codex, …) or the MCP servers/skills you choose to install — report those upstream.
Forge reduces risk (vetting before install, secret redaction, sandbox wiring) but is not
itself a sandbox.

## Hardening for maintainers

- Require 2FA for anyone with write access; use least-privilege tokens.
- Branch-protect `master`: require PR + green CI + review; block force-push.
- Enable GitHub secret scanning and CodeQL **default setup** (Settings → Code security).
- Dependency updates land via Dependabot (7-day cooldown); the `dependency-review` job blocks
  PRs that introduce known-vulnerable or disallowed-license dependencies.
- Releases publish from CI with npm provenance (OIDC) + a scoped `NPM_TOKEN` — never a
  long-lived token in code.
