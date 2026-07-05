# Accessibility

forgekit is a terminal tool plus docs and optional generated UI. Accessibility here means
the CLI output, the docs, and anything it generates are usable by everyone.

## What we do
- **CLI output never relies on color alone** — status is shown by symbol *and* word
  (`✓ ok`, `! warn`, `✗ fail`, `PASS`, `BLOCKED`), so it reads on monochrome terminals
  and to screen readers.
- **Docs** use semantic Markdown: headings in order, real lists/tables, descriptive link
  text, and alt text on badges.
- **Generated UI** (the `taste` design directions and any landing page) targets **WCAG 2.1
  AA**: sufficient contrast, visible keyboard focus, and `prefers-reduced-motion` support.
  The `corporate` taste is the AA-first default.

## Reporting an accessibility issue
Open an issue with the `accessibility` label, or start a Discussion. We treat accessibility
bugs as regular bugs, not nice-to-haves.

## Known gaps
A few CLI glyphs assume a UTF-8 terminal; ASCII fallbacks are welcome PRs.
