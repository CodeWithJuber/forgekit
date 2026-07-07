# Security Policy

## Supported Versions

Only the latest minor line of forgekit receives security updates.

| Version | Supported |
| ------- | --------- |
| 0.5.x   | ✅ Yes    |
| < 0.5   | ❌ No     |

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

**In scope:** the forgekit CLI and its emitters/guards; the `skill-gate` scanner
(including prompt-injection patterns `forge scan` should catch but doesn't); secret
handling in guards; the published npm package (`@codewithjuber/forgekit`) and its
install channels; the team ledger's integrity properties (below); the supply chain of
our own dev dependencies.

**Out of scope:** vulnerabilities in the third-party tools Forge configures (Claude Code,
Cursor, Codex, …) or the MCP servers/skills you choose to install — report those upstream.
Forge reduces risk (vetting before install, secret redaction, sandbox wiring) but is not
itself a sandbox.

## Ledger forgery resistance

The team ledger (proof-carrying memory) is shared, mergeable state — so it is designed to
resist forged confidence, not just corruption:

- **Content-addressed claims.** A claim's id *is* the hash of its canonical JSON bytes.
  `forge ledger verify` recomputes every content hash and reports any record whose bytes
  don't match its address as tampered/invalid.
- **Oracle weights are never trusted from records.** `val()` re-reads each oracle's weight
  from the in-code `ORACLES` table at read time; a `w` field stored in an evidence record
  is audit metadata only. A forged record cannot grant itself extra weight.
- **Append-only, hash-deduped evidence logs.** Merge is a conflict-free set union; corrupt
  or unknown-oracle lines are skipped rather than counted. Confidence is earned from valid
  evidence, never asserted by a record.

Protocol details: [docs/plans/substrate-v2/01-pcm-protocol.md](./docs/plans/substrate-v2/01-pcm-protocol.md).
A way to make the ledger report a `val` its evidence doesn't support is a security bug —
report it.

## Hardening for maintainers

- Require 2FA for anyone with write access; use least-privilege tokens.
- Branch-protect `master`: require PR + green CI + review; block force-push.
- Enable GitHub secret scanning + push protection (Settings → Code security). In CI:
  CodeQL (`.github/workflows/codeql.yml` — advanced setup, so keep *default setup* off),
  gitleaks (`security.yml`, blocking), and OSSF Scorecard (`scorecard.yml`).
- Dependency updates land via Dependabot (7-day cooldown); the `dependency-review` job blocks
  PRs that introduce known-vulnerable or disallowed-license dependencies.
- Releases publish from CI with npm provenance (OIDC) + a scoped `NPM_TOKEN` — never a
  long-lived token in code.

## Standards mapping

forgekit's controls map to the 2026 baselines:

**OWASP LLM Top 10**
- Prompt injection / supply chain (LLM01/03/05): `forge scan` (skill-gate) blocks injection /
  RCE / exfil in a skill or MCP config **before** install.
- Insecure output handling / sensitive-info disclosure (LLM02/06): the `secret-redact` guard
  masks keys in tool output; `protect-paths` blocks secret-file reads/writes.
- Excessive agency (LLM08): guards enforce least privilege + human-in-the-loop
  (`permissionDecision` deny/ask); `forge harden` wires the OS sandbox.
- Unbounded consumption / model DoS (LLM10): the cost governor + doom-loop breaker cap runaway
  spend and thrash.
- Output integrity: `forge verify` (tests + hallucinated-symbol + provenance) treats AI output
  as untrusted and requires evidence before merge.

**NIST SSDF (SP 800-218):** *prepare* (this policy + GOVERNANCE); *protect* (zero-dep, signed
provenance, branch protection); *produce* (CI gate: lint / type / test / audit / dependency-review);
*respond* (this reporting process + Dependabot).

**SLSA:** releases publish from CI with npm **provenance** (build attestation). Pin third-party
GitHub Actions to commit SHAs before adding any.
