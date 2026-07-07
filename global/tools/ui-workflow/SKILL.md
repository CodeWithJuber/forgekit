---
name: ui-workflow
description: Reliable workflow for building or fixing UI so results look intentional, not generic. Use for any frontend/UI task — new screen, component, redesign, "make it look better", layout, styling, or when the user says UI is the pain point.
---

# UI workflow

UI is unreliable when taste is vague and there's no check. Fix both: lock ONE
visual direction, build on the project's real components, then verify with the
deterministic design gate and a screenshot instead of guessing.

## 0. Pick ONE direction — don't stack taste sources
Competing taste/design skills produce muddy, inconsistent output. Per project,
choose **one** source of visual truth: the repo's `DESIGN.md` (create it with
`forge taste <style>` or the `design-md` tool), or a reference URL/screenshot
from the user. If none exists, ask.

## 1. Ground the components (current APIs, not memory)
- Reuse the project's existing components and design tokens first —
  `forge atlas query <Component>` finds them.
- Confirm any library's props/API against current docs, not recall; vet new
  dependencies with `tech-selector`.

## 2. Build
- Match the project's stack and component system over bespoke CSS.
- Accessibility is not optional: labels, focus states, contrast, keyboard nav.

## 3. Verify (the step that makes UI reliable)
- **Deterministic gate first:** `forge uicheck design <files> --taste <style>`
  (exit 1 on fail) — slop distance to generic templates must stay HIGH,
  conformance to the project's minted fingerprint must stay LOW, spacing/radius/
  shadow on scale. Failures are per-feature edits, not a score. If the repo has
  no fingerprint yet, mint one from approved UI:
  `forge uicheck fingerprint <files> --mint`.
- `forge uicheck contrast <fg> <bg>` for exact WCAG math — never eyeball it.
- **Then screenshot:** render at desktop AND mobile widths, compare against the
  reference/DESIGN.md, list concrete differences (spacing, hierarchy, color,
  alignment) and fix. For a second opinion, hand the screenshot + reference to
  the `frontend-verifier` subagent.

## Done =
Passes `forge uicheck design`, matches the reference at both breakpoints, passes
accessibility checks, uses the project's tokens/components, and you've shown the
final screenshot as evidence.
