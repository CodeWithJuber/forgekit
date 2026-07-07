---
name: design-md
description: Create and maintain a per-project DESIGN.md that pins the ONE visual direction so UI stays consistent across sessions and screens. Use when starting UI on a project, when look feels inconsistent, or the user mentions design system / DESIGN.md / visual guidelines.
---

# DESIGN.md

The fix for "UI comes out inconsistent" is a single written source of visual
truth per project. `ui-workflow` says pick one direction — `DESIGN.md` is where
that direction lives so every session and screen obeys the same rules.
`forge taste <style>` writes a managed one from Forge's menu; hand-write it only
for a bespoke direction.

Create it at the start of UI work, or the first time output drifts. One file at
repo root; reference it from the project `CLAUDE.md` (`See @DESIGN.md for visual
rules`) so Claude loads it. Keep it tight: concrete rules and tokens, not
adjectives — "Primary #4F46E5, 8pt spacing scale, Inter", not "modern and clean".

## Template
```markdown
# DESIGN.md — <project>

## Direction
One sentence + 1-2 reference links/screenshots. The single aesthetic. Don't mix.

## Tokens
- Color: primary / bg / surface / text / border / success / warn / danger (hex)
- Type: font family; scale (e.g. 12/14/16/20/24/32); weights
- Spacing: base unit (e.g. 4px) + scale; radius; shadow levels
- Breakpoints: mobile / tablet / desktop widths

## Components
- Library: <project components / component system> — reuse, don't hand-roll
- Buttons/inputs/cards: variants + states (default/hover/focus/disabled) rules
- Density, alignment, and layout grid rules

## Do / Don't
- Do: <3-5 concrete rules>
- Don't: <3-5 concrete anti-patterns for THIS project>

## Accessibility baseline
Contrast ≥ 4.5:1 body; visible focus rings; labels on inputs; keyboard nav;
hit targets ≥ 44px.

## References
Links to the reference site(s)/Figma this design matches.
```

## Enforce it (prose steers; the gate checks)
Once real UI matches the direction, mint its fingerprint:
`forge uicheck fingerprint <ui files> --mint`. Then `forge uicheck design <files>
--taste <style>` gates new UI against the taste constraints + project fingerprint
(a Forge-managed DESIGN.md is picked up automatically). When the user approves a
new visual decision, update DESIGN.md and re-mint so it sticks.
