# ADR 0004: Which 2026 production standards apply to a zero-dep CLI

- Status: accepted
- Date: 2026-07-05

## Context
The 2026 production-engineering standard (NIST SSDF, OWASP API/LLM Top 10, SLSA, clean/
hexagonal architecture, NestJS/Prisma/Docker/OpenTelemetry, OpenAPI) targets networked
services. forgekit is a zero-dependency, single-purpose CLI + Claude Code plugin — not a
service with a database, HTTP API, or containers.

## Decision
Apply the standard by RELEVANCE, guided by "don't over-pattern simple code" (and ADR 0001).

**Applies to forgekit itself:**
- Boundary validation — parse untrusted JSON / args / tool output before use.
- Typed hygiene via `tsc --checkJs` + JSDoc (no runtime dependency).
- Explicit error handling; no swallowed errors; safe messages.
- Supply-chain security: zero runtime deps, Dependabot (cooldown), dependency-review,
  secret scanning, npm provenance (SLSA-flavored), OWASP-LLM controls (see SECURITY.md).
- CI gate: format, lint, typecheck, tests, shellcheck, audit, dependency-review.

**Does NOT apply (would over-engineer / violate ADR 0001):**
- NestJS / hexagonal DI / repository+DTO layering — there is no service or DB.
- Prisma / PostgreSQL / Redis / outbox / migrations — no datastore.
- Docker / k8s / Terraform — nothing to containerize.
- OpenTelemetry tracing / OpenAPI — no long-running service or HTTP API.

**Propagated, not applied:** the full service-side standard (validation, authz/BOLA, typed
error model, observability, AI-output verification) is encoded in `source/rules.json`, so
`forge sync` emits it into every APP repo Forge configures. Forge *carries* the standard; it
doesn't cosplay a service.

## Consequences
- (+) forgekit stays small, boring, and dependency-free while meeting the security + SDLC parts
  of the standard, and spreads the full standard to the repos it touches.
- (−) Reviewers expecting a NestJS-style layout won't find one here — by design; see this ADR.
