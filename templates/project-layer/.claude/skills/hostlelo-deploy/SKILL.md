---
name: hostlelo-deploy
description: Safe, staged deploy of Hostlelo services to the VPS. Use when asked to deploy, ship, or release a Hostlelo change (kernel, widget, or Telegram control plane).
disable-model-invocation: true
---

# Hostlelo deploy

Staged deploy with a check at each gate. Never skip verification. Never deploy
with a failing build or uncommitted secrets.

## Preflight
1. `git status` — clean tree, no `.env`/keys staged.
2. Run tests + typecheck + build locally; abort on any failure.
3. Confirm target: kernel box vs Hermes vs widget/CDN. Confirm branch.
4. If DB schema changed: review the migration, confirm it's reversible, and get
   explicit user OK before running it against prod.

## Deploy
5. Push to the deploy branch / trigger the pipeline (use `gh`/CLI, not manual
   clicks). Prefer the project's existing deploy script over ad-hoc commands.
6. Apply migrations in order; capture output.

## Verify (required)
7. Health check the service (HTTP 200 / expected response) via the public URL
   behind Cloudflare.
8. Smoke test the changed surface:
   - Widget: load `widget.js`, confirm a grounded price answer, confirm no
     hallucinated numbers.
   - Telegram: one command round-trips.
9. Report: what deployed, migration result, health/smoke evidence, and the
   rollback command if it needs reverting.

## Rollback
State the exact revert (previous release/tag or `git revert`) before finishing so
it's one step away if something regresses.

<!-- Replace bracketed bits with real host targets/scripts; keep secrets out. -->
