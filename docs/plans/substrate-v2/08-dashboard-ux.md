# 08 — `forge dash` and the UX layer

> ForgeKit's own user experience: a local dashboard that makes the substrate's state —
> memory, cost, cache, blast radius, drift — visible and steerable. The substrate's
> decisions are auditable by design (paper §5, 17:36's audit trail; §9.1 "a transparent
> rubric … the user can see and override"); this is the surface where a human actually
> sees them. Phase P7.

## 0. Shape

- `forge dash [--port 4242]` — Node `http` server (stdlib), serving one self-contained
  HTML file (inline CSS/JS, no CDN — the `landing/index.html` precedent) plus small JSON
  endpoints that read `.forge/` stores. Localhost-only by default; read-mostly (the two
  writes below are explicit POSTs).
- Works offline, no build step, no framework. It must pass its own gate: uicheck v2 +
  a taste profile ([07](./07-ui-quality-gate.md)) — the dashboard is the reference
  customer of the UI quality gate.

## 1. Panels → data contracts

| panel | shows | reads |
|---|---|---|
| **Ledger** | claims by kind/layer (ʿilm/fahm/ḥikma), val sparkline per claim (evidence history re-scored over time), contested claims (val ∈ [0.4,0.6] with contradictions), attic | `.forge/ledger/` |
| **Cost** | spend by stage (gate/cache/context/route/generate/verify), measured savings vs. baseline, budget meter (the statusline meter, expanded) | `.forge/metrics.jsonl` |
| **Reuse** | hit rate (exact/near/adapt/miss), tokens saved, top-served artifacts with their evidence, artifacts nearing the val floor | metrics + ledger `artifact` claims |
| **Impact** | atlas blast-radius explorer: pick a symbol → dependents graph (SVG, hop-decay shading like paper Fig. 4), edge tier (ast/regex/verified) | `.forge/atlas.json` |
| **Session** | goal claim, CUSUM drift chart with alarm threshold, doom-loop signatures + diagnoses, M6 checkpoint log | `.forge/trace/` |
| **Team** | claims by author, per-author trust weight, recently merged teammate evidence, promotion queue | ledger provenance |

Every number links to its provenance (claim id → `forge ledger blame` view) — no
unexplained scores anywhere in the UI, matching the CLI's rubric-transparency rule.

## 2. The two writes

1. **Ratify** — promote a fahm claim to ḥikma ([01](./01-pcm-protocol.md) §5): one click,
   mints a `decision` claim with the human as author. Promotion is human-only by design.
2. **Retract** — tombstone a claim with a reason. Both append-only, so the dashboard
   can never corrupt the ledger; both are also available as CLI (`forge ledger ratify|
   retract`) so the dashboard is a convenience, never a requirement.

## 3. CLI polish (same phase, small)

- Uniform table/color renderer for all `forge` list outputs (one module, respects
  `NO_COLOR` and `--json` everywhere — several commands already do; make it the rule).
- `forge doctor` gains substrate-v2 checks: ledger normal-form, merge driver installed,
  atlas tier coverage, metrics file writable.
- Every gate refusal (impact/context/uicheck) prints the same three-part shape:
  *what was blocked · the computed reason (the missing-set / signature / feature deltas) ·
  the exact command to inspect it* — refusals teach, not just deny.

## 4. Non-goals

No hosted app, no auth, no multi-user server, no websockets. The ledger is the shared
state; the dashboard is a local lens on it. If two teammates both run `forge dash`, they
see the same truth after `git pull` — that is the sync story, and it is enough.
