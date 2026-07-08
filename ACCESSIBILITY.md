# Accessibility

forgekit is one brain for every AI coding agent — mostly a terminal tool, plus a few web
surfaces. This page says, honestly, what we check and what we don't. Where a claim is
machine-enforced we say so; where it isn't, we don't dress it up as conformance.

## The surfaces

forgekit has three places a person actually looks at output:

- **CLI output** — every `forge` command. Plain text.
- **`forge dash`** — a localhost-only, read-only web dashboard over the ledger, metrics, and
  blast radius (default port 4242; never exposed off `localhost`).
- **The public pages** — the landing page and the generated status page shipped to GitHub
  Pages.

## What we actually check

- **CLI output never relies on color alone.** Status is carried by symbol *and* word
  (`✓ ok`, `! warn`, `✗ fail`, `PASS`, `BLOCKED`), so it reads on a monochrome terminal and
  through a screen reader. Color is decoration, not information.
- **The public pages are gated in CI by `forge uicheck`.** Three checks run before a page
  ships: `uicheck contrast` (WCAG contrast ratios on the text/background token pairs),
  `uicheck fingerprint`/`design` (the design system stays on one 8-color / 4px scale), and
  `uicheck visual` (a Playwright rendered gate — the page is loaded in a real browser and the
  render is checked). A page that regresses contrast does not merge.
- **The pages are reduced-motion-safe by construction.** The only motion is a scroll-reveal
  effect, and it is *progressive enhancement*: it's JavaScript-gated, so with JS off — or for a
  crawler, or a reader that ignores it — the full content is present and static. Nothing is
  hidden behind an animation.
- **Docs use semantic Markdown:** headings in order, real lists and tables, descriptive link
  text, and alt text on images and badges.

## What we don't claim

We do **not** claim a formal WCAG 2.1/2.2 AA conformance level across every surface — we
haven't run a full audit, and we'd rather under-promise. What's above is what the gates
actually enforce. Contrast is measured; keyboard and screen-reader traversal of the dashboard
is not yet part of the automated gate. Treat any gap as a bug, not a design choice.

## Reporting an accessibility issue

Open an issue with the `accessibility` label, or start a
[Discussion](https://github.com/CodeWithJuber/forgekit/discussions). We treat accessibility
bugs as regular bugs, not nice-to-haves.

## Known gaps

- A few CLI glyphs assume a UTF-8 terminal; ASCII fallbacks are welcome PRs.
- The `forge dash` dashboard has not been through a full keyboard / screen-reader audit.
