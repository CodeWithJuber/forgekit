---
name: taste
description: Pick a visual design direction for a repo from Forge's menu (minimalist, brutalist, editorial, playful, corporate). Use when starting UI work or when the user wants a specific look. Sets DESIGN.md, which every AI tool then follows.
---

# taste — choose one design direction

Forge ships a MENU of visual directions; each repo pins exactly ONE.

- `forge taste` — list the available styles.
- `forge taste <style>` — write that style's spec to this repo's `DESIGN.md`.

The shared rules tell every tool to "follow DESIGN.md if present," so setting a
taste once steers Claude Code, Cursor, Codex, Gemini, and the rest. Switch anytime
with `forge taste <other>` (it regenerates DESIGN.md).

Styles: minimalist (restraint) · brutalist (raw/high-contrast) · editorial
(magazine/typographic) · playful (friendly/rounded) · corporate (trustworthy/AA).

Each style ships machine-readable constraints: prose steers generation, but
`forge uicheck design <files> --taste <style>` *checks* the result (style
auto-detected from a Forge-managed DESIGN.md). Mint the project fingerprint from
approved UI — `forge uicheck fingerprint <files> --mint` — to gate conformance too.

Don't hand-edit a Forge-managed DESIGN.md — re-run `forge taste`, or delete the
marker line to take it over yourself.
