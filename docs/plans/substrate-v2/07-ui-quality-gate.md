# 07 — The generated-UI quality gate: custom design, not templates

> Owner-named pain: AI-generated UI converges on the same generic template — the modal
> design is the max-likelihood completion, the same statistical failure shape as M5
> over-engineering (paper §5.5: "the maximum-likelihood objective favors the elaborate
> completion"; here it favors the *median* one). ForgeKit's taste layer
> (`global/taste/*.md`, `ui-workflow`, `design-md`) is prose; prose loses to gradients.
> This spec makes taste **measurable and enforceable** — guard-over-prose (ADR-0003)
> applied to design. Phase P6, extending `src/uicheck.js`.

## 0. Two-sided objective

Generated UI fails in two directions at once, so the gate scores two distances:

1. **Too close to the slop centroid** — the generic-AI look (default framework palette,
   uniform 8px spacing, one font, gradient hero, uniform rounded-xl cards).
2. **Too far from the project's own design system** — ignores the tokens, scales, and
   voice the codebase already has.

Good output is *far from generic and close to home*. Both are geometric statements once
UI is embedded as a feature vector — so embed it.

## 1. The design fingerprint (deterministic feature extraction)

`fingerprint(ui) → v ∈ ℝᵈ`, extracted by parsing CSS/JSX/Tailwind classes — pure static
analysis, zero LLM calls, zero screenshots needed for the core (same discipline as
`uicheck`'s WCAG math):

| group | features |
|---|---|
| **color** | palette as OKLCH points; palette size; hue histogram (12 bins); chroma mean/max; neutral-to-accent ratio; specific-hex flags for framework defaults |
| **space** | the observed spacing multiset; inferred base unit `u*` (argmin Σ min_k \|s − k·u\| over candidate units — approximate-GCD by residual minimization); scale ratio fit (geometric vs. linear); % of values on-scale |
| **type** | font-stack set; distinct sizes; modular-scale ratio fit `r*` (least-squares on log sizes); weight distribution |
| **shape** | radius multiset + entropy (uniform-radius = template tell); border/shadow token count; shadow-elevation levels |
| **layout** | container widths; grid/flex ratio; density (elements/viewport heuristic); hero/card/section pattern counts |

Normalization per feature (z-score against the corpus, below) so distances are
scale-free. The **project fingerprint** `v_proj` is extracted the same way from the
repo's existing UI + design tokens (tailwind config, CSS custom properties, theme files)
and stored as a `fingerprint` claim in the ledger — shared with the team, updated by the
same evidence rules as everything else ([01](./01-pcm-protocol.md)).

## 2. Slop distance and conformance

Ship a small corpus of **generic-template fingerprints** `Z = {z₁…z_m}` (extracted from
the recognizable default outputs: untouched framework starters, the canonical
AI-landing-page look, default shadcn/Tailwind palettes — a curated fixture set in
`source/slop-corpus.json`, versioned and extensible). Then:

```
slop(v)    = min_j ‖v − z_j‖₂      (distance to nearest generic centroid)
conform(v) = ‖v − v_proj‖₂         (distance from the project's own system)

gate: PASS  iff  slop(v) ≥ τ_s  ∧  conform(v) ≤ τ_c
```

- Weighted L2 — color and space dominate (they carry the "looks generic" signal);
  weights + thresholds live in the taste profile (§3) and get P8 fixtures.
- Greenfield repo (no `v_proj`): conformance term is replaced by the *chosen taste
  profile's* target region (§3), so the gate still has a "home" to pull toward.
- Failure output is **actionable, not a score**: the top-k features driving each
  violation — "palette is default-Tailwind blue (slop Δ 0.04 on color); spacing is
  uniform 8px (scale entropy 0); project uses 1.25-ratio type scale, output uses one
  size" — each mapped to a concrete edit.

## 3. Taste profiles become constraint sets

Each `global/taste/<name>.md` (brutalist, corporate, editorial, minimalist, playful)
gains a machine-readable sibling `<name>.json`:

```
{ "palette":  { "max_hues": 3, "chroma": [0.02, 0.12], "neutrals": "warm" },
  "space":    { "scale": "geometric", "ratio": [1.4, 1.6], "base": [4, 8] },
  "type":     { "scale_ratio": [1.2, 1.333], "max_families": 2 },
  "shape":    { "radius_levels": [0, 2], "shadow_levels": [0, 1] },
  "gate":     { "tau_slop": 0.35, "tau_conform": 0.5, "feature_weights": {…} } }
```

The prose file keeps the *why* and the vocabulary (it still steers generation); the JSON
is what the gate checks (it catches what steering missed). `forge taste` learns
`--check <files>`.

## 4. Perceptual constraint checks (uicheck v2)

Deterministic per-file assertions extending `ASSERTABLE_CHECKS` in `src/uicheck.js`
(alongside the existing WCAG contrast math):

- **Scale conformance:** every spacing/size value on the declared scale within ε
  (flags the pixel-soup that reads as "off" without anyone knowing why).
- **Palette bounds:** hue count ≤ max; min pairwise ΔE (OKLCH) between accents — no
  five-blues; chroma within profile range.
- **Consistency entropies:** radius/shadow/weight entropy under threshold (a design
  system uses few levels, deliberately).
- **Contrast:** existing WCAG checks, unchanged.

All emit `pass|fail + fix hint`, `--json` for hooks; the PostToolUse guard runs them on
edited UI files (advisory by default, enforcing under `FORGE_ENFORCE=1`, same ladder as
the other gates).

## 5. The visual loop (the only non-static part)

Static analysis can't see rendered composition. Under ADR-0005, the
`frontend-verifier` crew agent gets Playwright:

- Screenshot changed routes/components at 2 viewports; attach to the review.
- The *reviewer* (different model than the generator — C12 discipline,
  [06](./06-faculties-and-mechanisms.md) §4) judges against the taste profile's prose +
  the fingerprint report, and its accept/reject is an `outcome` claim on the component's
  `artifact` — so reused UI components carry visual-review evidence too
  ([03](./03-reuse-cache.md)).
- Optional visual regression: pixel-diff against the last accepted screenshot of the same
  component (stored ref in the artifact claim), flagging unintended drift.

## 6. Why this can work (and its limits)

The mechanism is honest about what it is: **fingerprint geometry catches the measurable
signature of genericness** — the features that make everyone say "that looks
AI-generated" are, concretely, default palettes, flat spacing, single-size type, uniform
radii, and those are all extractable. It cannot measure *beauty*; it measures *distance
from generic* and *distance from your system*, which is the tractable 80 % of the
complaint. The subjective residue stays with the visual-loop reviewer and the human —
the gate's job is to stop the template from ever reaching them. Thresholds start
advisory and only become enforcing once the P8 fixture set (known-slop vs. known-custom
UI corpus) shows separation, same as every other research-edge gate
([00-overview.md](./00-overview.md) §4).
