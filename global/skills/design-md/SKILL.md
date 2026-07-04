---
name: design-md
description: Create and maintain a per-project DESIGN.md that pins the ONE visual direction so UI stays consistent across sessions and screens. Use when starting UI on a project, when look feels inconsistent, or the user mentions design system / DESIGN.md / visual guidelines.
---

# DESIGN.md

The fix for "UI comes out inconsistent" is a single written source of visual
truth per project. `ui-workflow` says pick one direction — `DESIGN.md` is where
that direction lives so every session and screen obeys the same rules.

## When to create it
At the start of UI work on a repo, or the first time output drifts. One file at
repo root: `DESIGN.md`. Reference it from the project `CLAUDE.md`
(`See @DESIGN.md for visual rules`) so Claude loads it.

## Keep it tight (it's read often)
Concrete rules and tokens, not adjectives. "Primary #4F46E5, 8pt spacing scale,
Inter" — not "modern and clean". Prune anything Claude already gets right.

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
- Library: <shadcn/ui via MCP | project components> — reuse, don't hand-roll
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

## Use it
- Building UI: load DESIGN.md, follow it exactly, pull components via the shadcn
  MCP / project library, then run `ui-workflow`'s screenshot-verify against the
  DESIGN.md references and the `frontend-verifier` agent.
- When the user approves a new visual decision, update DESIGN.md so it sticks.
