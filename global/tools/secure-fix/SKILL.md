---
name: secure-fix
description: Fix a security vulnerability without breaking legitimate users — map the blast radius before touching code, keep public contracts stable, make the smallest diff, roll out a necessary break in phases (warn, support both, remove), try new rules in report-only mode first, and prove both that the exploit fails and that valid old inputs still work. Use for CVEs, injection, auth and authorization bugs, key rotation, hashing upgrades and vulnerable dependencies.
---

# Secure fix

Never cure one harm by causing an equal one. A patch that closes a hole but breaks real
customers replaces one incident with another. Work in this order.

## 1. Map the blast radius before touching code

List every upstream caller, downstream consumer, webhook, shared database column, exported
type and external client that touches the vulnerable code.

- `forge impact <symbol>` lists direct references first, then downstream files.
- `forge impact --diff` checks the coupled files your change did not name.
- Read the access logs: legitimate clients (older mobile apps, partner integrations) are
  mixed in with the hostile traffic. Know who you would hit before you block anything.

## 2. Fix behind the stable interface

Keep routes, request and response shapes, status codes, function signatures and environment
variable names exactly as they are. Neutralise the input inside the handler, scope the query,
or wrap the legacy logic in an adapter that validates and rate-limits under the hood.

## 3. Smallest possible diff

Touch only the lines that close the hole. No refactors, renames, formatting sweeps or
unrelated upgrades in a security change: they hide the fix from review and make it harder to
revert.

## 4. Phase any break that cannot be avoided

1. **Warn:** log and mark the old path deprecated.
2. **Support both:** accept the old and the new form at once (two keys, two hash formats,
   two token types).
3. **Remove:** turn the old path off only when telemetry shows no legitimate use is left.

Try new enforcement (firewall rules, CSP headers, stricter auth checks) in report-only or
shadow mode first, and look at what would have broken in real traffic before you enforce it.

## 5. Two proofs

Every patch ships with two green tests:

- **Negative:** reproduces the exploit and shows it is now blocked.
- **Positive:** shows that valid old inputs and edge cases give the same results as before.

`forge verify` runs both with the rest of the suite. Before a new dependency or a bump,
`forge vet <ecosystem:name>`; before installing a skill or MCP server, `forge scan`.

## Worked patterns

| Problem | Breaking way | Non-breaking way |
| --- | --- | --- |
| Weak password hashes | Wipe the hashes and log everyone out | Wrap the old hash in the strong one now, and re-hash each user's password on their next login |
| Object-level authorization (IDOR) | Rename the route and break every client | Keep the route; scope the query to the authenticated tenant from the session |
| Leaked key | Revoke it at once and take services down | Accept the new and the old key, roll the new one out, confirm the old one sees no traffic, then remove it |

## Three roles for an agent team

1. **Impact cartographer** (read-only): produces the blast-radius report.
2. **Patcher:** must preserve every exported signature and schema, and writes both proofs.
3. **Compatibility critic:** compares contracts, types and migrations before and after, and
   rejects a change that breaks one without a flag or a dual-read fallback.

`forge prompts show impact-cartographer` and `forge prompts show compatibility-critic` print
portable briefs for the first and the third.
